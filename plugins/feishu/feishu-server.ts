#!/usr/bin/env bun
/**
 * Feishu/Lark channel for Claude Code.
 *
 * Inbound: Feishu event subscription (long-connection mode) -> channel events.
 * Outbound: Claude tool call `reply` -> Feishu IM message API.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as lark from "@larksuiteoapi/node-sdk";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Profile-gated startup: FEISHU_PROFILE must be set to activate the channel.
// Without it the MCP server runs idle — no Feishu connection, no resources.
// This prevents every Claude Code instance from spawning a WS connection.
// ---------------------------------------------------------------------------
const FEISHU_PROFILE = process.env.FEISHU_PROFILE ?? "";
const CHANNEL_ACTIVE = FEISHU_PROFILE !== "";

// CLAUDE_TTY_INJECT: drives inbound Feishu messages into the Claude Code prompt
// via keystroke injection into the terminal multiplexer. Required because Claude
// Code 2.1.x+ treats channel notifications as out-of-band — they appear in the
// terminal but do NOT drive the prompt, so Claude sees them but never responds.
//
// Format (when set manually):
//   screen:<session>   e.g. screen:claude (run inside `screen -S claude`)
//   tmux:<target>      e.g. tmux:%0 or tmux:work:0.0
//   ""                 disabled
//
// Auto-detection (recommended): when CLAUDE_TTY_INJECT is not set in the
// environment, the plugin auto-detects $STY (screen) or $TMUX/$TMUX_PANE (tmux)
// and enables injection automatically. These variables are inherited from the
// multiplexer session that launched Claude Code down to this MCP server process.
// To disable auto-detection, explicitly set CLAUDE_TTY_INJECT="" in the profile
// .env file.
const CLAUDE_TTY_INJECT =
  "CLAUDE_TTY_INJECT" in process.env
    ? (process.env.CLAUDE_TTY_INJECT ?? "")
    : autoDetectTTYInject();

// FEISHU_IMAGE_DIR: base directory for downloaded Feishu images.
// Default (when unset): the profile state directory, so images land alongside
// logs without any configuration. Images are stored in a "feishu-channel-cache"
// subdirectory so cleanup is always scoped and never touches unrelated files.
// Set FEISHU_IMAGE_DIR="" explicitly to disable image download entirely.
const _defaultImageBase =
  process.env.FEISHU_STATE_DIR ??
  join(homedir(), ".claude", "channels", "feishu", "profiles", FEISHU_PROFILE || "_idle");
const FEISHU_IMAGE_DIR_RAW =
  "FEISHU_IMAGE_DIR" in process.env
    ? (process.env.FEISHU_IMAGE_DIR ?? "")
    : (CHANNEL_ACTIVE ? _defaultImageBase : "");
const FEISHU_IMAGE_ENABLED = FEISHU_IMAGE_DIR_RAW !== "";
const FEISHU_IMAGE_DIR = FEISHU_IMAGE_ENABLED
  ? join(FEISHU_IMAGE_DIR_RAW, "feishu-channel-cache")
  : "";
const FEISHU_IMAGE_TTL_HOURS = Number(process.env.FEISHU_IMAGE_TTL_HOURS ?? "24");
// TTY injection has hard length limits (screen "stuff" docs explicitly warn
// against large buffers). We cap the body and append a "[truncated]" marker
// so users know to switch to terminal for the rest.
const TTY_INJECT_MAX_BYTES = Number(process.env.FEISHU_TTY_INJECT_MAX_BYTES ?? "1500");

const STATE_DIR =
  process.env.FEISHU_STATE_DIR ??
  join(homedir(), ".claude", "channels", "feishu", "profiles", FEISHU_PROFILE || "_idle");
const LOG_FILE = join(STATE_DIR, "feishu.log");

function fileLog(message: string): void {
  if (!CHANNEL_ACTIVE) return;
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] ${message}\n`);
  } catch {}
}

// Global error handlers — keep the process alive so Claude Code doesn't
// report an MCP server crash.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`feishu channel: unhandled rejection: ${String(err)}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`feishu channel: uncaught exception: ${String(err)}\n`);
});

// Reliable parent-exit detection: if the parent process (Claude Code) dies,
// our stdin closes. We also poll to catch reparenting to init (ppid 1).
// This prevents zombie bun processes lingering after Claude Code exits.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write("feishu channel: shutting down\n");
  try {
    if (wsClient && typeof wsClient.stop === "function") wsClient.stop();
  } catch {}
  try { stopImageCleanupLoop(); } catch {}
  // Force exit after a short grace period — don't let dangling connections
  // keep the process alive.
  setTimeout(() => process.exit(0), 500);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

// Poll for parent death: when Claude Code exits, our ppid becomes 1 (init).
const parentPid = process.ppid;
const ppidTimer = setInterval(() => {
  if (process.ppid !== parentPid) {
    process.stderr.write("feishu channel: parent process gone, exiting\n");
    clearInterval(ppidTimer);
    shutdown();
  }
}, 2000);
ppidTimer.unref();

// The Lark SDK's default logger uses console.log/console.info which write to
// stdout. Since MCP uses stdio (JSON-RPC over stdout/stdin), any non-JSON-RPC
// output on stdout corrupts the protocol. Redirect all SDK logs to stderr.
const stderrLogger = {
  error(...msg: unknown[]) {
    process.stderr.write(`[error]: ${msg.map(String).join(" ")}\n`);
  },
  warn(...msg: unknown[]) {
    process.stderr.write(`[warn]: ${msg.map(String).join(" ")}\n`);
  },
  info(...msg: unknown[]) {
    process.stderr.write(`[info]: ${msg.map(String).join(" ")}\n`);
  },
  debug(...msg: unknown[]) {
    process.stderr.write(`[debug]: ${msg.map(String).join(" ")}\n`);
  },
  trace(...msg: unknown[]) {
    process.stderr.write(`[trace]: ${msg.map(String).join(" ")}\n`);
  },
};

// --- Lark SDK clients (only created when CHANNEL_ACTIVE) -------------------
let client: lark.Client | null = null;
let wsClient: any = null;
let access: { allowFrom: string[] } = { allowFrom: [] };
let requireAllowlist = false;
const DEBUG = process.env.FEISHU_DEBUG === "true";

if (CHANNEL_ACTIVE) {
  const ENV_FILE = join(STATE_DIR, ".env");
  const ACCESS_FILE = join(STATE_DIR, "access.json");
  loadDotEnv(ENV_FILE);

  const APP_ID = process.env.FEISHU_APP_ID;
  const APP_SECRET = process.env.FEISHU_APP_SECRET;
  const DOMAIN = process.env.FEISHU_DOMAIN;

  if (!APP_ID || !APP_SECRET) {
    process.stderr.write(
      `feishu channel [${FEISHU_PROFILE}]: FEISHU_APP_ID and FEISHU_APP_SECRET are required\n` +
        ` set in ${ENV_FILE}\n` +
        " format:\n" +
        " FEISHU_APP_ID=cli_xxx\n" +
        " FEISHU_APP_SECRET=xxx\n"
    );
    process.exit(1);
  }

  requireAllowlist = process.env.FEISHU_REQUIRE_ALLOWLIST === "true";
  access = loadAccess(ACCESS_FILE, STATE_DIR);
  if (requireAllowlist && access.allowFrom.length === 0) {
    process.stderr.write(
      `feishu channel [${FEISHU_PROFILE}]: FEISHU_REQUIRE_ALLOWLIST=true but allowFrom is empty; all inbound messages will be dropped\n`
    );
  }

  const baseConfig: { appId: string; appSecret: string; domain?: string } = {
    appId: APP_ID,
    appSecret: APP_SECRET,
  };
  if (DOMAIN) baseConfig.domain = DOMAIN;

  client = new lark.Client({ ...baseConfig, logger: stderrLogger });
  wsClient = new lark.WSClient({
    ...baseConfig,
    loggerLevel: lark.LoggerLevel.info,
    logger: stderrLogger,
  });

  debugLog(
    `boot config: profile=${FEISHU_PROFILE} app_id=${mask(APP_ID)} domain=${DOMAIN || "default"} allowlist_size=${
      access.allowFrom.length
    } require_allowlist=${String(requireAllowlist)}`
  );
} else {
  process.stderr.write(
    "feishu channel: FEISHU_PROFILE not set — running idle (no Feishu connection)\n" +
      " set FEISHU_PROFILE=<name> to activate a profile\n"
  );
}

// Track pending "GET" reactions so we can remove them when Claude replies.
// Key: chat_id, Value: array of {messageId, reactionId} awaiting reply.
const pendingReactions = new Map<
  string,
  ReadonlyArray<{ readonly messageId: string; readonly reactionId: string }>
>();

const LAST_CHAT_ID_FILE = join(STATE_DIR, "last_chat_id");
const REACTION_EMOJI = process.env.FEISHU_REACTION_EMOJI ?? "Get";

// Permission-relay: 5 lowercase letters a-z minus 'l' (avoids l/1/I confusion).
// Case-insensitive for phone autocorrect. Matches "y xxxxx" / "yes xxxxx" / "n xxxxx" / "no xxxxx".
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// Stores full permission details keyed by request_id for "See more" expansion.
const pendingPermissions = new Map<
  string,
  { readonly tool_name: string; readonly description: string; readonly input_preview: string }
>();

// Helper to send a text message to a Feishu chat.
async function sendText(chatId: string, text: string): Promise<void> {
  if (!client) return;
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

// Send a startup notification to the last known chat.
let startupNotified = false;
function notifyStartup(): void {
  if (startupNotified) return;
  const chatId = readLastChatId();
  if (!chatId) return;
  startupNotified = true;
  const profileLabel = FEISHU_PROFILE ? ` [${FEISHU_PROFILE}]` : "";
  const cwd = process.cwd();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  sendText(
    chatId,
    `✅ Claude Code${profileLabel} 已就绪，可以发消息了\n📁 ${cwd}\n📅 ${today}`,
  ).catch((err) => {
    fileLog(`startup notification failed: ${String(err)}`);
  });
  fileLog(`startup notification sent to chat_id=${chatId}`);
}

function readLastChatId(): string {
  try {
    return readFileSync(LAST_CHAT_ID_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function saveLastChatId(chatId: string): void {
  try {
    writeFileSync(LAST_CHAT_ID_FILE, chatId, { mode: 0o600 });
  } catch {}
}

const mcp = new Server(
  { name: "feishu", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        // Permission-relay opt-in: allows Claude Code to forward tool approval
        // prompts to Feishu so users can approve/deny remotely via card buttons.
        // Safe because gate (shouldDeliver/allowFrom) already drops non-allowlisted senders.
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      "Messages from Feishu arrive as <channel source=\"feishu\" ...>.",
      "To send a response to Feishu users, always call the reply tool with the same chat_id.",
      "The user reads messages in Feishu, not this terminal. Plain transcript text is not delivered unless you call reply.",
      "Feishu bots cannot read full chat history in this channel; if older context is needed, ask the user to paste it.",
      "When a message contains a local file path for a downloaded image, use the Read tool to view it before composing a reply.",
    ].join("\n"),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a text reply to Feishu chat.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "Feishu chat_id from inbound channel message meta.",
          },
          text: {
            type: "string",
            description: "Text to send.",
          },
          receive_id_type: {
            type: "string",
            enum: ["chat_id", "open_id", "union_id", "user_id", "email"],
            description:
              "Feishu receive_id_type. Default is chat_id. For channel relay, keep chat_id.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (req.params.name !== "reply") {
    return {
      content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }

  try {
    const receiveId = String(args.chat_id ?? "");
    const text = String(args.text ?? "");
    const receiveIdType = asReceiveIdType(args.receive_id_type);

    if (!receiveId) throw new Error("chat_id is required");
    if (!text) throw new Error("text is required");
    if (!client) throw new Error("channel not active — set FEISHU_PROFILE to enable");

    const res: any = await client.im.v1.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: "markdown", content: text }],
        }),
      },
    });

    const messageId = res?.data?.message_id ?? "unknown";

    // Remove pending "GET" reactions for this chat (best-effort, non-blocking).
    const reactions = pendingReactions.get(receiveId);
    if (client && reactions && reactions.length > 0) {
      pendingReactions.delete(receiveId);
      const c = client;
      Promise.allSettled(
        reactions.map((r) =>
          c.im.messageReaction.delete({
            path: { message_id: r.messageId, reaction_id: r.reactionId },
          })
        )
      ).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            debugLog(`failed to remove reaction: ${String(result.reason)}`);
          }
        }
      });
    }

    return {
      content: [{ type: "text", text: `sent (message_id: ${messageId})` }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `reply failed: ${msg}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Permission relay: receive permission_request from Claude Code, send
// interactive card with Yes/No buttons to all allowlisted users.
// ---------------------------------------------------------------------------

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

const CODEBLOCK_MAX_LINES = 5;

function formatCodeBlock(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length <= CODEBLOCK_MAX_LINES) {
    return `\`\`\`\n${raw}\n\`\`\``;
  }
  const visible = lines.slice(0, CODEBLOCK_MAX_LINES).join("\n");
  const remaining = lines.length - CODEBLOCK_MAX_LINES;
  return `\`\`\`\n${visible}\n\`\`\`\n... +${remaining} lines`;
}

function buildPermissionCard(
  requestId: string,
  toolName: string,
  description: string,
  inputPreview: string,
): Record<string, unknown> {
  let prettyInput: string;
  try {
    prettyInput = JSON.stringify(JSON.parse(inputPreview), null, 2);
  } catch {
    prettyInput = inputPreview;
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🔐 ${description}` },
      template: "orange",
    },
    elements: [
      {
        tag: "markdown",
        content: `**Tool:** \`${toolName}\`\n${formatCodeBlock(prettyInput)}`,
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ Yes" },
            type: "primary",
            value: { action: "allow", request_id: requestId },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ No" },
            type: "danger",
            value: { action: "deny", request_id: requestId },
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `y ${requestId} / n ${requestId}`,
          },
        ],
      },
    ],
  };
}

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const { request_id, tool_name, description, input_preview } = params;
  pendingPermissions.set(request_id, { tool_name, description, input_preview });
  debugLog(`permission_request received: id=${request_id} tool=${tool_name}`);

  const cardJson = buildPermissionCard(request_id, tool_name, description, input_preview);
  const cardContent = JSON.stringify(cardJson);
  const lastChatId = readLastChatId();

  // Send to last known chat if available; otherwise DM each allowlisted user.
  // Avoid sending both to prevent duplicate cards for users in the group chat.
  if (!client) return;
  if (lastChatId) {
    client.im.v1.message
      .create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: lastChatId,
          msg_type: "interactive",
          content: cardContent,
        },
      })
      .catch((err) => {
        fileLog(`permission card send failed (chat): ${String(err)}`);
      });
  } else {
    // No active chat — DM each allowlisted user as fallback.
    for (const openId of access.allowFrom) {
      client.im.v1.message
        .create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: openId,
            msg_type: "interactive",
            content: cardContent,
          },
        })
        .catch((err) => {
          debugLog(`permission card DM to ${openId} failed: ${String(err)}`);
        });
    }
  }
});


// === WS startup MOVED to BEFORE `await mcp.connect()` ===
// bun has a non-deterministic scheduling bug where the microtask
// continuation after `await mcp.connect()` can fail to execute (verified
// via /proc/<pid>/fdinfo: bun parked in ep_poll, fileLog 'pre-WS gate'
// never written even with empty image cache and patch in place). Running
// WS startup pre-connect sidesteps the wedge entirely — WS is up before
// mcp.connect binds stdio. The only mcp.notification() call (permission
// verdict relay) is .catch()-voided, so the <10ms stdio-bind window is
// safely covered. First Feishu event takes >100ms, well after connect.
// Hoist before startImageCleanupLoop() call below — `let` is in TDZ until
// its declaration line runs, so the call would throw ReferenceError when
// FEISHU_IMAGE_ENABLED is true (the short-circuit `!FEISHU_IMAGE_ENABLED ||`
// only saves us when image download is disabled).
let imageCleanupTimer: ReturnType<typeof setInterval> | null = null;
// Kick off periodic image-cache cleanup. No-op when FEISHU_IMAGE_DIR isn't set,
// so it stays back-compat for users who never enable image download.
startImageCleanupLoop();

fileLog(`pre-WS gate: CHANNEL_ACTIVE=${CHANNEL_ACTIVE} client=${!!client} wsClient=${!!wsClient}`);
if (CHANNEL_ACTIVE && client && wsClient) {
// Previously: await new Promise((r) => setTimeout(r, 2000)) — meant as a
// defensive delay to let Claude Code finish MCP initialization (listTools)
// before WS starts. In practice this top-level await sometimes never resumes
// in bun after mcp.connect's stdio transport binds (verified via
// /proc/<pid>/fdinfo: no 2000ms timerfd armed, process parked in ep_poll).
// We do NOT need the delay: Feishu's first event arrives 100ms+ after WS
// handshake, well after Claude Code's listTools completes. Drop the delay
// entirely so the inbound path is guaranteed to come up.
fileLog("post-connect delay skipped, starting WS client immediately");

const larkClient = client!;
const larkWsClient = wsClient!;

const dispatcher = new lark.EventDispatcher({
  logger: stderrLogger,
}).register({
  "im.message.receive_v1": async (event: any) => {
    fileLog("im.message.receive_v1 event fired");
    process.stderr.write("feishu channel: im.message.receive_v1 event fired\n");
    try {
      const senderOpenId =
        event?.sender?.sender_id?.open_id ??
        event?.sender?.sender_id?.user_id ??
        "";
      const deliver = shouldDeliver(senderOpenId, access.allowFrom, requireAllowlist);
      debugLog(
        `inbound event: sender=${senderOpenId || "unknown"} message_type=${
          event?.message?.message_type ?? "unknown"
        } chat_id=${event?.message?.chat_id ?? "unknown"} deliver=${String(deliver)}`
      );

      const message = event?.message ?? {};
      const chatId = String(message.chat_id ?? "");
      if (!chatId) return;

      // Handle built-in commands before access check — allow anyone to query their own ID.
      const textContent = extractTextContent(message.message_type, message.content);
      if (isMyIdCommand(textContent)) {
        debugLog(`responding to my-id command from ${senderOpenId}`);
        await sendText(
          chatId,
          `Your open_id: ${senderOpenId}\n\nTo add to allowlist, ask the admin to run:\n/feishu:access add ${senderOpenId}`
        );
        return;
      }

      if (!deliver) {
        return;
      }

      // Permission-reply intercept: if this looks like "y xxxxx" / "n xxxxx"
      // for a pending permission request, emit the verdict instead of relaying
      // as chat. The sender already passed the allowFrom gate.
      const permMatch = PERMISSION_REPLY_RE.exec(textContent);
      if (permMatch) {
        const requestId = permMatch[2]!.toLowerCase();
        const behavior = permMatch[1]!.toLowerCase().startsWith("y") ? "allow" : "deny";
        debugLog(`permission verdict via text: id=${requestId} behavior=${behavior}`);
        void mcp
          .notification({
            method: "notifications/claude/channel/permission",
            params: { request_id: requestId, behavior },
          })
          .catch((err) => {
            fileLog(`permission verdict notification failed: ${String(err)}`);
          });
        pendingPermissions.delete(requestId);
        // Acknowledge with emoji reaction.
        const messageId = String(message.message_id ?? "");
        if (messageId) {
          const emoji = behavior === "allow" ? "OK" : "CrossMark";
          larkClient.im.messageReaction
            .create({
              path: { message_id: messageId },
              data: { reaction_type: { emoji_type: emoji } },
            })
            .catch(() => {});
        }
        return;
      }

      // Persist last active chat for startup notification on next restart.
      saveLastChatId(chatId);

      const messageId = String(message.message_id ?? "");

      // Try event payload content first; if empty for non-text types, fetch via API.
      let rawContent = message.content;
      debugLog(`event content type=${typeof rawContent} value=${JSON.stringify(rawContent)?.slice(0, 300)}`);
      if (!rawContent && messageId) {
        debugLog(`content empty for message_type=${message.message_type}, fetching via API`);
        try {
          const fetched: any = await larkClient.im.message.get({
            path: { message_id: messageId },
          });
          const body = fetched?.data?.items?.[0]?.body?.content ?? fetched?.data?.body?.content;
          if (body) {
            rawContent = body;
            debugLog(`API fetch content: ${String(rawContent).slice(0, 300)}`);
          }
        } catch (fetchErr) {
          debugLog(`API fetch failed: ${String(fetchErr)}`);
        }
      }

      // For image / post messages with embedded images, download the binary
      // first so Claude can Read() the file. Synchronous to the notification
      // path: a failed download falls back to the plain text so the channel
      // notification is never lost. Gated by FEISHU_IMAGE_ENABLED.
      let content = formatMessageContent(message.message_type, rawContent);
      const msgType = String(message.message_type ?? "");
      if (FEISHU_IMAGE_ENABLED && (msgType === "image" || msgType === "post") && messageId) {
        const imageKeys = extractAllImageKeys(msgType, rawContent);
        if (imageKeys.length > 0) {
          const paths: string[] = [];
          for (const k of imageKeys) {
            const p = await downloadFeishuImage(messageId, k);
            if (p) paths.push(p);
          }
          if (paths.length > 0) {
            if (msgType === "image") {
              content = `[飞书图片已下载到 ${paths[0]}，请用 Read 工具查看]`;
            } else {
              // For post: keep the user's text, replace (image) placeholders
              // with concrete local paths so claude can Read() each one.
              let idx = 0;
              content = content.replace(/\(image\)/g, () => {
                const p = paths[idx++] ?? "(image)";
                return p === "(image)" ? p : `[飞书图片:${p}]`;
              });
            }
          }
        }
      }

      const userName =
        event?.sender?.sender_id?.open_id ??
        event?.sender?.sender_id?.user_id ??
        "unknown";
      const ts = toIsoString(message.create_time);

      mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          meta: {
            chat_id: chatId,
            ...(messageId ? { message_id: messageId } : {}),
            user: userName,
            user_id: String(senderOpenId || "unknown"),
            ...(ts ? { ts } : {}),
          },
        },
      }).catch((err) => {
        fileLog(`notification FAILED: ${String(err)}`);
      });
      fileLog(`notification sent: chat_id=${chatId} message_id=${messageId || "unknown"}`);
      process.stderr.write(
        `feishu channel: notification sent for chat_id=${chatId} message_id=${messageId || "unknown"}\n`
      );
      debugLog(
        `forwarded to claude: chat_id=${chatId} message_id=${messageId || "unknown"} user_id=${
          senderOpenId || "unknown"
        }`
      );

      // Optionally inject into the Claude Code TTY so the message becomes a
      // real user prompt (not just a side-channel notification). Disabled by
      // default — see CLAUDE_TTY_INJECT comment near the top of the file.
      if (CLAUDE_TTY_INJECT) {
        // Fire-and-forget but with awaited internal ordering so screen/tmux
        // delivery is atomic (text then Enter, not racing). On failure, log
        // loudly AND tell the Feishu user (debounced) — silent drop is worse
        // than annoying notifications because users wait for a reply that
        // never comes.
        injectToTTY(content)
          .then((r) => {
            if (r.ok) {
              fileLog(`tty inject succeeded via ${CLAUDE_TTY_INJECT}`);
            } else {
              fileLog(`tty inject FAILED via ${CLAUDE_TTY_INJECT}: ${r.reason}`);
              notifyInjectFailure(chatId, r.reason ?? "unknown");
            }
          })
          .catch((e) => fileLog(`tty inject rejected: ${String(e)}`));
      }

      // Add "GET" reaction as a read receipt; store reaction_id for removal on reply.
      if (messageId) {
        try {
          const reactionRes: any = await larkClient.im.messageReaction.create({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: REACTION_EMOJI } },
          });
          const reactionId = reactionRes?.data?.reaction_id as string | undefined;
          if (reactionId) {
            const existing = pendingReactions.get(chatId) ?? [];
            pendingReactions.set(chatId, [...existing, { messageId, reactionId }]);
            debugLog(`added ${REACTION_EMOJI} reaction: message_id=${messageId} reaction_id=${reactionId}`);
          }
        } catch (err) {
          debugLog(`failed to add reaction: ${String(err)}`);
        }
      }
    } catch (err) {
      process.stderr.write(`feishu channel: inbound handler failed: ${String(err)}\n`);
    }
  },
});

// Card action handler for permission relay button clicks.
// Receives card.action.trigger events via WSClient when a user clicks
// Allow/Deny/See More on a permission card.
const cardHandler = new lark.CardActionHandler(
  {},
  async (data: any) => {
    try {
      const actionValue = data?.action?.value ?? {};
      const action = String(actionValue.action ?? "");
      const requestId = String(actionValue.request_id ?? "");
      const operatorOpenId = String(data?.operator?.open_id ?? "");

      debugLog(
        `card.action.trigger: action=${action} request_id=${requestId} operator=${operatorOpenId}`
      );

      if (!requestId || !action) {
        return { toast: { type: "info", content: "Unknown action" } };
      }

      // Verify the operator is in the allowlist.
      if (
        access.allowFrom.length > 0 &&
        !access.allowFrom.includes(operatorOpenId)
      ) {
        return { toast: { type: "error", content: "Not authorized" } };
      }

      if (action === "allow" || action === "deny") {
        const behavior = action;
        void mcp
          .notification({
            method: "notifications/claude/channel/permission",
            params: { request_id: requestId, behavior },
          })
          .catch((err) => {
            fileLog(`permission verdict notification failed: ${String(err)}`);
          });
        const details = pendingPermissions.get(requestId);
        pendingPermissions.delete(requestId);
        const label = behavior === "allow" ? "✅ Yes" : "❌ No";
        debugLog(`permission verdict via card: id=${requestId} behavior=${behavior}`);

        // Return updated card wrapped in callback response format.
        // Feishu requires: { card: { type: "raw", data: { ...cardJson } } }
        // Retain command content so user can review historical operations.
        let contentMd: string;
        if (details) {
          let prettyInput: string;
          try {
            prettyInput = JSON.stringify(JSON.parse(details.input_preview), null, 2);
          } catch {
            prettyInput = details.input_preview;
          }
          contentMd = `**Tool:** \`${details.tool_name}\`\n${formatCodeBlock(prettyInput)}`;
        } else {
          contentMd = `**Request ID:** \`${requestId}\``;
        }
        return {
          toast: { type: behavior === "allow" ? "success" : "warning", content: label },
          card: {
            type: "raw",
            data: {
              config: { wide_screen_mode: true },
              header: {
                title: {
                  tag: "plain_text",
                  content: `🔐 ${label}${details ? ` — ${details.tool_name}` : ""}`,
                },
                template: behavior === "allow" ? "green" : "red",
              },
              elements: [
                {
                  tag: "markdown",
                  content: contentMd,
                },
              ],
            },
          },
        };
      }

      return { toast: { type: "info", content: "Unknown action" } };
    } catch (err) {
      fileLog(`card action handler error: ${String(err)}`);
      return { toast: { type: "error", content: "Internal error" } };
    }
  }
);

// In WS mode, callbacks must be handled by eventDispatcher.
// Reuse the existing cardHandler callback implementation to build response payload.
dispatcher.register({
  "card.action.trigger": async (data: any) => cardHandler.cardHandler(data),
});

larkWsClient.start({ eventDispatcher: dispatcher, cardHandler });
fileLog("websocket client started");
process.stderr.write(`feishu channel [${FEISHU_PROFILE}]: websocket started\n`);

// Send startup notification after WS client has connected (3s delay).
setTimeout(notifyStartup, 3000);
} // end if (CHANNEL_ACTIVE)

await mcp.connect(new StdioServerTransport());
fileLog("mcp transport connected");


function loadDotEnv(filePath: string) {
  try {
    chmodSync(filePath, 0o600);
  } catch {}

  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {}
}

type Access = { allowFrom: string[] };

function loadAccess(accessFile: string, stateDir: string): Access {
  const fromEnv = (process.env.FEISHU_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const raw = readFileSync(accessFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<Access>;
    const fileList = Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [];
    return {
      allowFrom: uniqueStrings([...fileList, ...fromEnv]),
    };
  } catch {
    const data = { allowFrom: uniqueStrings(fromEnv) };
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(accessFile, JSON.stringify(data, null, 2) + "\n", {
        mode: 0o600,
      });
    } catch {}
    return data;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function shouldDeliver(senderId: string, allowFrom: string[], strict: boolean): boolean {
  if (!senderId) return false;
  if (allowFrom.includes(senderId)) return true;
  if (strict) return false;
  return allowFrom.length === 0;
}

// ---------------------------------------------------------------------------
// TTY injection: keystroke inbound text into the Claude Code terminal so it
// drives the prompt (vs being just an out-of-band channel notification).
//
// Auto-detection: checks $STY (GNU screen) and $TMUX/$TMUX_PANE (tmux).
// These env vars are inherited by child processes from the multiplexer session
// that launched Claude Code, so they are available here without extra config.
//
// Limitations: message body is best-effort plaintext. Control characters are
// stripped and newlines collapsed to spaces. Large messages are truncated.
// ---------------------------------------------------------------------------

// Detect if the current process is running inside a terminal multiplexer and
// return the CLAUDE_TTY_INJECT-format string for injecting into it.
// Called only when CLAUDE_TTY_INJECT is not set in the environment.
function autoDetectTTYInject(): string {
  // GNU screen: $STY = "<pid>.<session-name>" inside any screen session.
  // All child processes (including Claude Code and this MCP server) inherit it.
  const sty = process.env.STY ?? "";
  if (sty) {
    // Extract just the session name (after the first dot).
    const dotIdx = sty.indexOf(".");
    const sessionName = dotIdx >= 0 ? sty.slice(dotIdx + 1) : sty;
    process.stderr.write(
      `feishu channel: auto-detected screen session "${sessionName}" ($STY=${sty}) — TTY injection enabled\n` +
        `  Feishu messages will drive the Claude prompt like terminal input.\n` +
        `  To disable: set CLAUDE_TTY_INJECT="" in the profile .env\n`
    );
    return `screen:${sessionName}`;
  }

  // tmux: $TMUX is set inside any tmux session; $TMUX_PANE holds the pane ID
  // (e.g. "%0"). Both are inherited by child processes of the tmux pane.
  const tmuxEnv = process.env.TMUX ?? "";
  if (tmuxEnv) {
    const pane = process.env.TMUX_PANE ?? "";
    if (!pane) {
      // $TMUX is set but $TMUX_PANE isn't — shouldn't happen, skip auto-detect.
      process.stderr.write(
        `feishu channel: $TMUX is set but $TMUX_PANE is empty — skipping TTY auto-detection\n` +
          `  Set CLAUDE_TTY_INJECT=tmux:<target> manually to enable injection.\n`
      );
      return "";
    }
    process.stderr.write(
      `feishu channel: auto-detected tmux pane "${pane}" — TTY injection enabled\n` +
        `  Feishu messages will drive the Claude prompt like terminal input.\n` +
        `  To disable: set CLAUDE_TTY_INJECT="" in the profile .env\n`
    );
    return `tmux:${pane}`;
  }

  return "";
}
const TTY_TRUNCATE_SUFFIX = " [truncated]";
const TTY_TRUNCATE_SUFFIX_BYTES = Buffer.byteLength(TTY_TRUNCATE_SUFFIX, "utf8");

function sanitizeForTTY(text: string): { body: string; truncated: boolean } {
  // Drop \r, NUL, and other control chars; flatten newlines to space so a single
  // CR at the end submits the whole line. screen(1) explicitly notes "you
  // cannot paste large buffers with the 'stuff' command", and tmux has similar
  // buffer limits — enforce a HARD byte cap (including the suffix) so partial
  // delivery isn't silent and the final injected blob is never over budget.
  const cleaned = text
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
    .replace(/\r?\n/g, " ");
  if (Buffer.byteLength(cleaned, "utf8") <= TTY_INJECT_MAX_BYTES) {
    return { body: cleaned, truncated: false };
  }
  const buf = Buffer.from(cleaned, "utf8");

  // Edge case: if the max is so small the suffix alone doesn't fit, skip the
  // marker entirely — better silent truncation than overshooting the hard cap.
  // (Codex round 3 fix.)
  if (TTY_INJECT_MAX_BYTES <= TTY_TRUNCATE_SUFFIX_BYTES) {
    let body = buf.subarray(0, TTY_INJECT_MAX_BYTES).toString("utf8").replace(/�+$/u, "");
    while (Buffer.byteLength(body, "utf8") > TTY_INJECT_MAX_BYTES && body.length > 0) {
      body = body.slice(0, -1);
    }
    return { body, truncated: true };
  }

  // Normal path: reserve room for the suffix so the FINAL payload is still
  // ≤ TTY_INJECT_MAX_BYTES (Codex round 2 fix).
  const budget = TTY_INJECT_MAX_BYTES - TTY_TRUNCATE_SUFFIX_BYTES;
  let body = buf.subarray(0, Math.min(buf.length, budget)).toString("utf8");
  body = body.replace(/�+$/u, "");
  while (Buffer.byteLength(body + TTY_TRUNCATE_SUFFIX, "utf8") > TTY_INJECT_MAX_BYTES && body.length > 0) {
    body = body.slice(0, -1);
  }
  return { body: body + TTY_TRUNCATE_SUFFIX, truncated: true };
}

type RunResult = { code: number; stderr: string };

function runOnce(cmd: string, args: string[]): Promise<RunResult> {
  // screen(1) writes "No screen session found." to STDOUT (not stderr) — so we
  // pipe both and merge into the same buffer for diagnostics. tmux writes its
  // errors to stderr normally; capturing both is harmless either way.
  return new Promise((resolve) => {
    let buf = "";
    try {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
      });
      child.on("error", (e) => {
        fileLog(`tty inject ${cmd} spawn error: ${String(e)}`);
        resolve({ code: -1, stderr: String(e) });
      });
      child.on("exit", (code) => resolve({ code: code ?? 0, stderr: buf.trim() }));
    } catch (e) {
      fileLog(`tty inject ${cmd} threw: ${String(e)}`);
      resolve({ code: -1, stderr: String(e) });
    }
  });
}

type InjectResult = { ok: boolean; reason?: string };

async function injectToTTY(text: string): Promise<InjectResult> {
  if (!CLAUDE_TTY_INJECT) return { ok: true };
  const colonIdx = CLAUDE_TTY_INJECT.indexOf(":");
  if (colonIdx <= 0) {
    const reason = `CLAUDE_TTY_INJECT malformed (expected tool:session): ${CLAUDE_TTY_INJECT}`;
    fileLog(reason);
    return { ok: false, reason };
  }
  const tool = CLAUDE_TTY_INJECT.slice(0, colonIdx);
  const session = CLAUDE_TTY_INJECT.slice(colonIdx + 1);
  const { body, truncated } = sanitizeForTTY(text);
  if (!body) return { ok: true };
  if (truncated) {
    fileLog(`tty inject truncated to ${TTY_INJECT_MAX_BYTES} bytes (original ${Buffer.byteLength(text, "utf8")}B)`);
  }

  try {
    if (tool === "screen") {
      // Two-step stuff: body first, brief settle, then CR. Mirrors the tmux
      // path so claude-code readline never sees a bracketed-paste race where
      // the terminating CR is absorbed as paste-end instead of submit.
      const r1 = await runOnce("screen", ["-S", session, "-X", "stuff", body]);
      if (r1.code !== 0) {
        const reason = `screen -S ${session} -X stuff (body) exit=${r1.code}${r1.stderr ? ` stderr=${r1.stderr}` : ""}`;
        fileLog(`tty inject FAILED: ${reason}`);
        return { ok: false, reason };
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const r2 = await runOnce("screen", ["-S", session, "-X", "stuff", "\r"]);
      if (r2.code !== 0) {
        const reason = `screen -S ${session} -X stuff (CR) exit=${r2.code}${r2.stderr ? ` stderr=${r2.stderr}` : ""}`;
        fileLog(`tty inject FAILED: ${reason}`);
        return { ok: false, reason };
      }
      return { ok: true };
    } else if (tool === "tmux") {
      // Two sequential send-keys: -l (literal) for the body, then Enter to
      // submit. We MUST await between them so the literal text lands before
      // Enter; otherwise tmux can process Enter first and submit empty.
      const r1 = await runOnce("tmux", ["send-keys", "-t", session, "-l", body]);
      if (r1.code !== 0) {
        const reason = `tmux send-keys -l exit=${r1.code}${r1.stderr ? ` stderr=${r1.stderr}` : ""}`;
        fileLog(`tty inject FAILED: ${reason}`);
        return { ok: false, reason };
      }
      const r2 = await runOnce("tmux", ["send-keys", "-t", session, "Enter"]);
      if (r2.code !== 0) {
        const reason = `tmux send-keys Enter exit=${r2.code}${r2.stderr ? ` stderr=${r2.stderr}` : ""}`;
        fileLog(`tty inject FAILED: ${reason}`);
        return { ok: false, reason };
      }
      return { ok: true };
    } else {
      const reason = `unsupported tool '${tool}' (expected 'screen' or 'tmux')`;
      fileLog(`CLAUDE_TTY_INJECT ${reason}`);
      return { ok: false, reason };
    }
  } catch (e) {
    const reason = `injectToTTY exception: ${String(e)}`;
    fileLog(reason);
    return { ok: false, reason };
  }
}

// Notify the Feishu chat when TTY inject fails, with a debounce so we
// never spam the user. One notification per chat per 5 minutes.
const INJECT_FAILURE_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;
const injectFailureNotifiedAt = new Map<string, number>();

function notifyInjectFailure(chatId: string, reason: string): void {
  const now = Date.now();
  const last = injectFailureNotifiedAt.get(chatId) ?? 0;
  if (now - last < INJECT_FAILURE_NOTIFY_INTERVAL_MS) return;
  injectFailureNotifiedAt.set(chatId, now);
  const msg =
    `⚠️ Feishu → Claude TTY 注入失败，你的消息没有送到 Claude prompt。\n` +
    `target: ${CLAUDE_TTY_INJECT}\n` +
    `reason: ${reason}\n\n` +
    `修复：在 ssh 终端里 \`screen -S claude\`（或对应 tmux 会话），然后在那里启动 claude。`;
  sendText(chatId, msg).catch((err) =>
    fileLog(`notifyInjectFailure send failed: ${String(err)}`)
  );
}

// ---------------------------------------------------------------------------
// Inbound image cache: download image bytes from Feishu so Claude can Read()
// them locally. Files live in a plugin-owned subdirectory
// "feishu-channel-cache" under FEISHU_IMAGE_DIR so the cleanup loop can never
// touch unrelated files even if the user picks a shared root path.
// Enabled only when FEISHU_IMAGE_DIR env is explicitly set.
// ---------------------------------------------------------------------------
function ensureImageDir(): void {
  if (!FEISHU_IMAGE_ENABLED) return;
  try {
    mkdirSync(FEISHU_IMAGE_DIR, { recursive: true, mode: 0o700 });
  } catch {}
}

function cleanupOldImages(): void {
  if (!FEISHU_IMAGE_ENABLED) return;
  ensureImageDir();
  const ttlMs = FEISHU_IMAGE_TTL_HOURS * 60 * 60 * 1000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const cutoff = Date.now() - ttlMs;
  try {
    // Only sweep our own cache subdir — never the parent FEISHU_IMAGE_DIR_RAW.
    for (const name of readdirSync(FEISHU_IMAGE_DIR)) {
      if (!name.startsWith("feishu_")) continue;
      const path = join(FEISHU_IMAGE_DIR, name);
      try {
        const st = statSync(path);
        if (st.mtimeMs < cutoff) unlinkSync(path);
      } catch {}
    }
  } catch (e) {
    fileLog(`cleanupOldImages failed: ${String(e)}`);
  }
}

// Periodic cleanup: runs every hour while the channel is active, and an
// immediate sweep on startup so a previously-aged-out tree doesn't linger.
function startImageCleanupLoop(): void {
  if (!FEISHU_IMAGE_ENABLED || imageCleanupTimer) return;
  cleanupOldImages();
  imageCleanupTimer = setInterval(() => {
    try { cleanupOldImages(); } catch (e) { fileLog(`image cleanup tick failed: ${String(e)}`); }
  }, 60 * 60 * 1000);
  // Don't keep the process alive solely for the cleanup tick.
  if (typeof imageCleanupTimer.unref === "function") imageCleanupTimer.unref();
}
function stopImageCleanupLoop(): void {
  if (imageCleanupTimer) {
    clearInterval(imageCleanupTimer);
    imageCleanupTimer = null;
  }
}

function extFromMimeOrDefault(mime: string | undefined): string {
  switch ((mime ?? "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    default:
      return ".jpg"; // Feishu most-common; lets Read() heuristics still work
  }
}

async function downloadFeishuImage(
  messageId: string,
  fileKey: string,
): Promise<string | null> {
  if (!FEISHU_IMAGE_ENABLED) return null;
  if (!messageId || !fileKey) return null;
  if (!client) {
    fileLog(`downloadFeishuImage skipped: lark client not initialized`);
    return null;
  }
  ensureImageDir();
  try {
    // SDK signature: messageResource.get(payload) -> { writeFile, getReadableStream, headers }
    // We use writeFile directly because it handles the stream-to-disk plumbing
    // and is documented to support up to 100MB resources.
    const res: any = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: "image" },
    });
    if (!res || typeof res.writeFile !== "function") {
      fileLog(
        `downloadFeishuImage unexpected SDK response messageId=${messageId} keys=${Object.keys(res ?? {}).join(",")}`,
      );
      return null;
    }
    const mime = res?.headers?.["content-type"] ?? "";
    const ext = extFromMimeOrDefault(typeof mime === "string" ? mime : "");
    const safeMsgId = messageId.replace(/[^A-Za-z0-9_-]/g, "_");
    const safeKey = fileKey.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 16);
    const path = join(FEISHU_IMAGE_DIR, `feishu_${safeMsgId}_${safeKey}${ext}`);
    await res.writeFile(path);
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {}
    if (bytes <= 0) {
      fileLog(`downloadFeishuImage zero-byte file messageId=${messageId} path=${path}`);
      try { unlinkSync(path); } catch {}
      return null;
    }
    fileLog(
      `downloadFeishuImage saved messageId=${messageId} bytes=${bytes} path=${path}`,
    );
    return path;
  } catch (e) {
    fileLog(
      `downloadFeishuImage failed messageId=${messageId} fileKey=${fileKey}: ${String(e)}`,
    );
    return null;
  }
}

function extractImageKey(rawContent: unknown): string {
  const content =
    typeof rawContent === "object" && rawContent !== null
      ? JSON.stringify(rawContent)
      : String(rawContent ?? "");
  try {
    const parsed = JSON.parse(content);
    return String(parsed?.image_key ?? "");
  } catch {
    return "";
  }
}

// Walk image / post content and collect every image_key.
// image: { image_key: "..." }
// post:  { title, content: [[{tag,...}, ...], ...] } where img nodes carry image_key
function extractAllImageKeys(messageType: string, rawContent: unknown): string[] {
  const raw =
    typeof rawContent === "object" && rawContent !== null
      ? JSON.stringify(rawContent)
      : String(rawContent ?? "");
  try {
    const parsed = JSON.parse(raw);
    if (messageType === "image") {
      const k = String(parsed?.image_key ?? "");
      return k ? [k] : [];
    }
    if (messageType === "post") {
      // Feishu post comes in two shapes:
      //   (a) flat:   { title, content: [[node,...], ...] }   ← what the API actually delivers
      //   (b) locale: { zh_cn: { title, content: [...] }, ... }  ← legacy/docs shape
      // Earlier patch only handled (b) via Object.values(parsed).find(..."content" in v),
      // which fails on (a) because parsed.content's value is an Array and arrays don't
      // have a "content" own-property → find returns undefined → keys=[] → no download.
      const keys: string[] = [];
      let paragraphs: unknown = (parsed as { content?: unknown })?.content;
      if (!Array.isArray(paragraphs)) {
        const localeData = Object.values(parsed).find(
          (v): v is { content?: unknown[][] } =>
            typeof v === "object" && v !== null && !Array.isArray(v) && "content" in v
        );
        paragraphs = localeData?.content;
      }
      if (!Array.isArray(paragraphs)) return [];
      for (const paragraph of paragraphs) {
        if (!Array.isArray(paragraph)) continue;
        for (const el of paragraph) {
          if (typeof el !== "object" || el === null) continue;
          const node = el as Record<string, unknown>;
          if (String(node.tag ?? "") === "img") {
            const k = String(node.image_key ?? "");
            if (k) keys.push(k);
          }
        }
      }
      return keys;
    }
  } catch {}
  return [];
}

function formatMessageContent(messageTypeRaw: unknown, contentRaw: unknown): string {
  const messageType = String(messageTypeRaw ?? "");
  // Preserve object content for post parsing; stringify only for text types
  const content =
    typeof contentRaw === "object" && contentRaw !== null
      ? JSON.stringify(contentRaw)
      : String(contentRaw ?? "");
  debugLog(`formatMessageContent: type=${messageType} content_type=${typeof contentRaw} content_len=${content.length} content_preview=${content.slice(0, 200)}`);

  if (messageType === "text") {
    try {
      const parsed = JSON.parse(content) as { text?: string };
      if (parsed.text) return parsed.text;
    } catch {}
    return content || "(empty text)";
  }

  if (messageType === "image") return "(image message)";
  if (messageType === "file") return "(file message)";
  if (messageType === "audio") return "(audio message)";
  if (messageType === "media") return "(media message)";
  if (messageType === "sticker") return "(sticker message)";
  if (messageType === "post") return parsePostContent(content);
  if (messageType === "interactive") return "(interactive card message)";
  if (messageType === "share_chat") return "(share chat message)";
  if (messageType === "share_user") return "(share user message)";
  return content || `(unsupported message type: ${messageType || "unknown"})`;
}

function toIsoString(tsRaw: unknown): string {
  const ts = String(tsRaw ?? "");
  if (!ts) return "";
  const num = Number(ts);
  if (Number.isNaN(num)) return "";
  // Feishu create_time is usually milliseconds as a string.
  return new Date(num).toISOString();
}

function mask(value: string | undefined): string {
  if (!value) return "empty";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function debugLog(message: string): void {
  fileLog(message);
  if (!DEBUG) return;
  process.stderr.write(`feishu channel [debug]: ${message}\n`);
}

const MY_ID_PATTERNS = [
  /^(我的|my)\s*(lark|feishu|飞书)?\s*(id|open.?id)$/i,
  /^what'?s?\s+my\s+(id|open.?id)$/i,
  /^\/?(myid|my.id|whoami)$/i,
];

function isMyIdCommand(text: string): boolean {
  const trimmed = text.trim();
  return MY_ID_PATTERNS.some((re) => re.test(trimmed));
}

function extractTextContent(messageTypeRaw: unknown, contentRaw: unknown): string {
  if (String(messageTypeRaw ?? "") !== "text") return "";
  try {
    const parsed = JSON.parse(String(contentRaw ?? "")) as { text?: string };
    return parsed.text ?? "";
  } catch {
    return "";
  }
}

/**
 * Parse Feishu "post" (rich text) message content into readable plain text.
 *
 * Post content structure:
 *   { "<locale>": { "title": "...", "content": [[inline_elements...], ...] } }
 *
 * Inline element tags: text, a (link), at (mention), img, media, emotion, etc.
 */
function parsePostContent(raw: string): string {
  debugLog(`parsePostContent raw (${raw.length} chars): ${raw.slice(0, 500)}`);
  try {
    // Handle case where raw might already be an object (stringified via String())
    const parsed: Record<string, unknown> =
      typeof raw === "object" && raw !== null
        ? (raw as unknown as Record<string, unknown>)
        : JSON.parse(raw);
    debugLog(`parsePostContent parsed keys: ${Object.keys(parsed).join(", ")}`);
    // Pick the first available locale (zh_cn, en_us, ja_jp, etc.)
    const localeData = Object.values(parsed).find(
      (v): v is { title?: string; content?: unknown[][] } =>
        typeof v === "object" && v !== null && "content" in v
    );
    if (!localeData?.content) return raw || "(empty rich text)";

    const paragraphs: string[] = [];

    if (localeData.title) {
      paragraphs.push(localeData.title);
    }

    for (const paragraph of localeData.content) {
      if (!Array.isArray(paragraph)) continue;
      const parts: string[] = [];
      for (const el of paragraph) {
        if (typeof el !== "object" || el === null) continue;
        const node = el as Record<string, unknown>;
        const tag = String(node.tag ?? "");
        if (tag === "text") {
          parts.push(String(node.text ?? ""));
        } else if (tag === "a") {
          const text = String(node.text ?? "");
          const href = String(node.href ?? "");
          parts.push(text && href ? `[${text}](${href})` : text || href);
        } else if (tag === "at") {
          parts.push(`@${String(node.user_name ?? node.user_id ?? "user")}`);
        } else if (tag === "emotion") {
          parts.push(`[${String(node.emoji_type ?? "emoji")}]`);
        } else if (tag === "img") {
          parts.push("(image)");
        } else if (tag === "media") {
          parts.push("(media)");
        }
      }
      paragraphs.push(parts.join(""));
    }

    const result = paragraphs.join("\n").trim();
    return result || "(empty rich text)";
  } catch (err) {
    debugLog(`parsePostContent error: ${String(err)}`);
    return raw || "(rich text message)";
  }
}

function asReceiveIdType(
  value: unknown
): "chat_id" | "open_id" | "union_id" | "user_id" | "email" {
  const v = String(value ?? "chat_id");
  if (v === "open_id") return "open_id";
  if (v === "union_id") return "union_id";
  if (v === "user_id") return "user_id";
  if (v === "email") return "email";
  return "chat_id";
}
