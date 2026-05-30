# Feishu Plugin Launchers

Operational helpers for running the `feishu` Claude Code plugin in headless / long-running setups.

## Scripts

| Script | Purpose |
|---|---|
| `start-claude.sh` | Launcher that wires up the Feishu channel + applies all three hardening pre-flights below. |
| `reorder_feishu_ws.py` | Patches `feishu-server.ts` to move WS startup **before** `await mcp.connect(...)`. Works around a bun scheduler bug that can wedge the WS init. Idempotent — re-runs detect existing reorder and no-op. |
| `feishu_mcp_watchdog.sh` | Spawned by `start-claude.sh` as a 30s background check. If `websocket client started` doesn't appear in the log, it pastes a warning into the screen prompt **and** DMs the user via Feishu API (tenant access token from `.env`). |

## Why these are needed

Three real failure modes observed in production:

1. **bun scheduling wedge** (2026-05-13): after a fresh plugin install, `feishu-server.ts` hung at `mcp transport connected` — the `setTimeout(2s)` that should kick off WS init never fired. Outbound replies still worked but inbound and startup-notification both silently dropped. `reorder_feishu_ws.py` moves the WS startup block ahead of the `await mcp.connect()`, sidestepping the scheduler bug.

2. **Silent startup failure** (2026-05-13): the wedge above had no symptom in the prompt — user thought the bot was up, but inbound was dead. `feishu_mcp_watchdog.sh` is a 30s watchdog that surfaces the failure both in the screen prompt and as a Feishu DM, so silent breakage becomes obvious within half a minute.

3. **Orphaned MCP holding the Lark WS slot** (2026-05-28): when claude exits unclean (Ctrl-C during init, OOM, etc.), the spawned `bun feishu-server.ts` child gets reparented to init (PPID=1) and keeps holding the WS connection. Lark allows **only one WS per app** — next claude start can't establish a working MCP, session loses feishu entirely. `start-claude.sh` scans for these orphans (`pgrep -x bun` + cmdline verification via `/proc`) and TERM/KILLs them before exec.

## Usage

```bash
# In a screen session named "claude" (rename via SCREEN_NAME env if needed):
screen -S claude -t main
bash /path/to/launchers/start-claude.sh
```

Required peer files in the same directory: `reorder_feishu_ws.py`, `feishu_mcp_watchdog.sh`.

## Configurable env

| Env | Default | Purpose |
|---|---|---|
| `CLAUDE_HOME` | `$HOME/.claude` | Claude Code state root |
| `FEISHU_PROFILE_NAME` | `default` | Channel profile name (any non-empty) |
| `FEISHU_STATE_DIR` | `$CLAUDE_HOME/channels/feishu` | Where `.env`, `access.json`, `last_chat_id` live |
| `FEISHU_IMAGE_DIR` | `/tmp/feishu_cache` | Inbound image download cache |
| `CLAUDE_TTY_INJECT` | `screen:claude` | Where to inject inbound messages — use `tmux:<target>` for tmux |
| `SCREEN_NAME` | `claude` | Screen session name used by `CLAUDE_TTY_INJECT` |
| `FEISHU_MCP_DEADLINE_SEC` | `30` | Watchdog grace period before alerting |

## Required peer files (not in this repo — you provide these)

```
$FEISHU_STATE_DIR/.env             # FEISHU_APP_ID=... \n FEISHU_APP_SECRET=...
$FEISHU_STATE_DIR/access.json      # {"allowFrom": ["ou_..."]}
$FEISHU_STATE_DIR/last_chat_id     # (optional) default DM recipient for watchdog alerts
```

`.env` and `access.json` contain credentials/identifiers — **never commit them**. Use `/feishu:configure` and `/feishu:access` from the plugin to populate them interactively.
