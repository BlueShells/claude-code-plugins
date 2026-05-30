#!/usr/bin/env bash
# Feishu MCP watchdog — verifies that the freshly-launched Claude Code session's
# feishu-server.ts reached `websocket client started` within the deadline.
# If not, paste a warning into the screen-attached claude prompt AND DM Feishu.
#
# Background: 2026-05-13 17:20 we shipped a fresh plugin install and the
# feishu-server.ts hung at `mcp transport connected` (setTimeout(2s) never
# fired). Outbound reply still worked, inbound and startup-notification both
# silently dropped, user reported "启动完没收到飞书通知 + 发消息也不回".
#
# Run as a SessionStart post-hook in detached form:
#   ( bash /opt/bbgo/scripts/feishu_mcp_watchdog.sh & ) </dev/null >/dev/null 2>&1
# or as a one-shot cron 30s after a known restart timestamp.

set -uo pipefail

FEISHU_STATE_DIR_DEFAULT="${HOME}/.claude/channels/feishu"
LOG="${FEISHU_LOG:-${FEISHU_STATE_DIR:-$FEISHU_STATE_DIR_DEFAULT}/feishu.log}"
ENV_FILE="${FEISHU_ENV_FILE:-${FEISHU_STATE_DIR:-$FEISHU_STATE_DIR_DEFAULT}/.env}"
LAST_CHAT_FILE="${LAST_CHAT_FILE:-${FEISHU_STATE_DIR:-$FEISHU_STATE_DIR_DEFAULT}/last_chat_id}"
DEADLINE_SEC="${FEISHU_MCP_DEADLINE_SEC:-30}"
SCREEN_TARGET="${SCREEN_TARGET:-claude}"

start_epoch=$(date +%s)
deadline=$((start_epoch + DEADLINE_SEC))

while [ "$(date +%s)" -lt "$deadline" ]; do
    if tail -200 "$LOG" 2>/dev/null | grep -q "websocket client started"; then
        last_ws_ts=$(tail -200 "$LOG" | grep "websocket client started" | tail -1 | awk -F'[][]' '{print $2}')
        last_ws_epoch=$(date -d "$last_ws_ts" +%s 2>/dev/null || echo 0)
        if [ "$last_ws_epoch" -ge "$start_epoch" ]; then
            exit 0
        fi
    fi
    sleep 2
done

# Failure path — gather context and alert.
last_logs=$(tail -5 "$LOG" 2>/dev/null | sed 's/"/\\"/g')
warning="⚠️ Feishu MCP watchdog: 启动 ${DEADLINE_SEC}s 仍未见 websocket client started，入方向可能已挂。请 Ctrl-C 重跑 start-claude.sh。\n最后 5 行:\n${last_logs}"

# 1) try to paste warning into the screen-attached claude REPL.
if command -v screen >/dev/null 2>&1; then
    screen -S "$SCREEN_TARGET" -p 0 -X stuff "[WATCHDOG] feishu MCP inbound 未起，30s 内无 websocket client started，请重启 claude。" 2>/dev/null || true
fi

# 2) try a direct Feishu DM via tenant_access_token so the user gets a push even
#    when inbound is broken.
if [ -f "$ENV_FILE" ] && [ -f "$LAST_CHAT_FILE" ]; then
    APP_ID=$(grep -E '^FEISHU_APP_ID=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    APP_SECRET=$(grep -E '^FEISHU_APP_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    CHAT_ID=$(cat "$LAST_CHAT_FILE" | tr -d '\n\r ')
    if [ -n "${APP_ID:-}" ] && [ -n "${APP_SECRET:-}" ] && [ -n "${CHAT_ID:-}" ]; then
        token_resp=$(curl -sS --max-time 5 -X POST \
            'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
            -H 'Content-Type: application/json' \
            -d "{\"app_id\":\"${APP_ID}\",\"app_secret\":\"${APP_SECRET}\"}" 2>/dev/null || true)
        TOKEN=$(echo "$token_resp" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("tenant_access_token",""))' 2>/dev/null || echo "")
        if [ -n "$TOKEN" ]; then
            payload=$(python3 -c "import json,sys;print(json.dumps({'receive_id':'${CHAT_ID}','msg_type':'text','content':json.dumps({'text':sys.argv[1]})}))" "$warning")
            curl -sS --max-time 5 -X POST \
                'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id' \
                -H "Authorization: Bearer $TOKEN" \
                -H 'Content-Type: application/json' \
                -d "$payload" >/dev/null 2>&1 || true
        fi
    fi
fi

exit 1
