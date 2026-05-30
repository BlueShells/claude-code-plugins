#!/usr/bin/env bash
# Claude Code launcher with Feishu plugin enabled, plus operational hardening:
#  1. Re-apply WS startup reorder patch (works around a bun scheduler bug)
#  2. Run a 30s post-launch watchdog that warns if MCP WS fails to start
#  3. Kill orphaned feishu MCP children before exec (Lark allows 1 WS per app)
#
# Run INSIDE a screen session named "claude" (or change CLAUDE_TTY_INJECT):
#   screen -S claude -t main
#   bash ./start-claude.sh
#
# Required peer scripts (same directory):
#   - reorder_feishu_ws.py
#   - feishu_mcp_watchdog.sh

set -euo pipefail

# --- Customize these paths if your layout differs ---
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
FEISHU_PROFILE_NAME="${FEISHU_PROFILE_NAME:-default}"
FEISHU_STATE_DIR_DEFAULT="$CLAUDE_HOME/channels/feishu"
FEISHU_IMAGE_DIR_DEFAULT="/tmp/feishu_cache"
SCREEN_NAME="${SCREEN_NAME:-claude}"
LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ----------------------------------------------------

# Channel needs a non-empty profile name to activate.
export FEISHU_PROFILE="$FEISHU_PROFILE_NAME"
export FEISHU_STATE_DIR="${FEISHU_STATE_DIR:-$FEISHU_STATE_DIR_DEFAULT}"

# Inbound bridge: drive the prompt via screen session.
# Switch to "tmux:<target>" if you use tmux.
export CLAUDE_TTY_INJECT="${CLAUDE_TTY_INJECT:-screen:$SCREEN_NAME}"

# Image download cache for inbound Feishu image messages.
export FEISHU_IMAGE_DIR="${FEISHU_IMAGE_DIR:-$FEISHU_IMAGE_DIR_DEFAULT}"
mkdir -p "$FEISHU_IMAGE_DIR"

# --------------------------------------------------------------------------
# Pre-flight 1: Re-apply WS startup reorder patch.
# bun has a non-deterministic scheduling bug where the microtask continuation
# after `await mcp.connect(new StdioServerTransport())` can fail to execute,
# wedging the WS startup that follows. Moving WS startup BEFORE the await
# sidesteps the wedge. Idempotent: detects "already reordered" and no-ops.
# --------------------------------------------------------------------------
FEISHU_CACHE_TS="$CLAUDE_HOME/plugins/cache/shidaxi/feishu/0.1.0/feishu-server.ts"
FEISHU_MK_TS="$CLAUDE_HOME/plugins/marketplaces/shidaxi/plugins/feishu/feishu-server.ts"
LOG_DIR="$FEISHU_STATE_DIR"
mkdir -p "$LOG_DIR"
if [ -x "$LAUNCHER_DIR/reorder_feishu_ws.py" ]; then
  python3 "$LAUNCHER_DIR/reorder_feishu_ws.py" \
    "$FEISHU_CACHE_TS" "$FEISHU_MK_TS" \
    >>"$LOG_DIR/feishu.log" 2>&1 || true
fi

# --------------------------------------------------------------------------
# Pre-flight 2: Spawn 30s MCP watchdog (detached so it survives exec).
# If `websocket client started` doesn't appear within 30s, pastes a warning
# into the screen prompt and DMs the user via Feishu API.
# --------------------------------------------------------------------------
if [ -x "$LAUNCHER_DIR/feishu_mcp_watchdog.sh" ]; then
  setsid -f bash "$LAUNCHER_DIR/feishu_mcp_watchdog.sh" >/dev/null 2>&1 || true
fi

# --------------------------------------------------------------------------
# Pre-flight 3: Kill orphaned feishu MCP children.
# When claude exits unclean, the feishu MCP child gets reparented to init
# (PPID=1) and keeps holding the Lark WS slot. Next claude start can't spawn
# a working MCP → session loses feishu. Lark allows only 1 active WS per app,
# so the orphan must die before we exec.
#
# Scan pgrep -x bun (exact comm match) then verify cmdline via /proc to avoid
# false-positives on shells that contain the pattern literally.
# --------------------------------------------------------------------------
find_feishu_orphans() {
  local pid cmdline out=""
  for pid in $(pgrep -x bun 2>/dev/null); do
    cmdline=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null) || continue
    case "$cmdline" in
      *feishu-server.ts*) out="$out $pid" ;;
    esac
  done
  echo "$out" | tr -s ' '
}
ORPHANS=$(find_feishu_orphans)
if [ -n "$ORPHANS" ]; then
  echo "[start-claude] killing orphaned feishu MCP:$ORPHANS" >&2
  kill -TERM $ORPHANS 2>/dev/null || true
  sleep 1
  STILL=$(find_feishu_orphans)
  if [ -n "$STILL" ]; then
    echo "[start-claude] orphan ignored TERM, escalating KILL:$STILL" >&2
    kill -KILL $STILL 2>/dev/null || true
  fi
fi

# --------------------------------------------------------------------------
# Launch Claude Code. --dangerously-skip-permissions is convenient for
# headless bot setups; remove it if you want manual permission prompts.
# --------------------------------------------------------------------------
exec claude \
  --dangerously-skip-permissions \
  "$@"
