#!/usr/bin/env python3
"""
Reorder feishu-server.ts to move WS startup BEFORE `await mcp.connect()`.

Why: bun has a non-deterministic scheduling bug where, after
`await mcp.connect(new StdioServerTransport())` resolves, the synchronous code
in the same microtask continuation can fail to execute (verified via
/proc/<bun>/fdinfo + log truncation at "mcp transport connected"). Moving WS
startup BEFORE the await sidesteps the wedge entirely — WS is already running
before mcp.connect has a chance to bind stdio and trigger the scheduler bug.

Idempotent: if the file is already reordered (cleanup block precedes await),
exits with status 0 without modifying anything.

Tradeoff: WS event handlers may be invoked before mcp.connect resolves. The
only mcp.notification() call site is voided with .catch(), so a notification
arriving during the <10ms stdio-bind window is safely dropped. Feishu's first
inbound event takes >100ms, so in practice mcp.connect has resolved well
before.
"""

import re
import sys
from pathlib import Path


AWAIT_RE = re.compile(r"^await mcp\.connect\(new StdioServerTransport\(\)\);")
CONNECTED_LOG_RE = re.compile(r'^fileLog\("mcp transport connected"\);')
END_IF_RE = re.compile(r"^\}\s*// end if \(CHANNEL_ACTIVE\)")
IMAGE_CLEANUP_COMMENT_RE = re.compile(r"^// Kick off periodic image-cache cleanup")


def find_line(lines, regex, start=0):
    for i in range(start, len(lines)):
        if regex.match(lines[i]):
            return i
    return None


def reorder(path: Path) -> None:
    text = path.read_text()
    lines = text.split("\n")

    await_idx = find_line(lines, AWAIT_RE)
    cleanup_idx = find_line(lines, IMAGE_CLEANUP_COMMENT_RE)

    if await_idx is None:
        raise SystemExit(f"{path}: cannot find `await mcp.connect(...)` line — file unrecognized")
    if cleanup_idx is None:
        raise SystemExit(f"{path}: cannot find `// Kick off periodic image-cache cleanup` marker")

    # Already reordered? cleanup block sits before the await.
    if cleanup_idx < await_idx:
        print(f"{path}: already reordered (cleanup at {cleanup_idx+1}, await at {await_idx+1}) — no-op")
        return

    connected_idx = find_line(lines, CONNECTED_LOG_RE, start=await_idx + 1)
    if connected_idx is None:
        raise SystemExit(f"{path}: cannot find mcp-transport-connected log after await")

    # cleanup block must be contiguous with the connected-log line (allow blank line)
    if cleanup_idx - connected_idx > 3:
        raise SystemExit(
            f"{path}: unexpected gap between mcp-transport-connected log ({connected_idx+1}) "
            f"and cleanup block ({cleanup_idx+1}) — manual review needed"
        )

    end_if_idx = find_line(lines, END_IF_RE, start=cleanup_idx + 1)
    if end_if_idx is None:
        raise SystemExit(f"{path}: cannot find end-of-CHANNEL_ACTIVE-if marker after cleanup block")

    # Block to move: from cleanup_idx through end_if_idx (inclusive)
    block_to_move = lines[cleanup_idx:end_if_idx + 1]

    explanatory_comment = [
        "",
        "// === WS startup MOVED to BEFORE `await mcp.connect()` ===",
        "// bun has a non-deterministic scheduling bug where the microtask",
        "// continuation after `await mcp.connect()` can fail to execute (verified",
        "// via /proc/<pid>/fdinfo: bun parked in ep_poll, fileLog 'pre-WS gate'",
        "// never written even with empty image cache and patch in place). Running",
        "// WS startup pre-connect sidesteps the wedge entirely — WS is up before",
        "// mcp.connect binds stdio. The only mcp.notification() call (permission",
        "// verdict relay) is .catch()-voided, so the <10ms stdio-bind window is",
        "// safely covered. First Feishu event takes >100ms, well after connect.",
    ]

    before_block = lines[:cleanup_idx]
    after_block = lines[end_if_idx + 1:]

    new_lines = (
        before_block[:await_idx]
        + explanatory_comment
        + block_to_move
        + [""]
        + before_block[await_idx:]
        + after_block
    )

    path.write_text("\n".join(new_lines))
    new_await_line = await_idx + len(explanatory_comment) + len(block_to_move) + 1
    print(
        f"{path}: reordered. WS block at lines "
        f"{await_idx + 1 + len(explanatory_comment)}..{new_await_line - 1}, "
        f"await now at line {new_await_line}"
    )


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        reorder(Path(arg))
