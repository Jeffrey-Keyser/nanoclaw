# Tool Logging — Live Diagnostics

Diagnostic findings for CEO tool call logging implementation (task 78216ebe).

## Architecture

Tool call logging flows through the existing two-DB session architecture:

```
Container (PostToolUse hook)
  → writes to tool_call_events in outbound.db
  → host reads outbound.db (read-only) for /activity and /topology
```

No IPC, no file watchers, no external hooks needed. The PostToolUse SDK hook
inside the container captures tool name, input (truncated), timing, and error
status, then inserts into the `tool_call_events` table in `outbound.db`.

## Failure Points (Pre-Fix)

### 1. No tool_call_events table existed

**Root cause**: The table was never created. The PostToolUse hook only cleared
`container_state` (tool-in-flight tracking) — it didn't log events.

**Fix**: Added `tool_call_events` table to:
- `container/agent-runner/src/db/connection.ts` (forward-compat CREATE IF NOT EXISTS)
- `src/db/schema.ts` (OUTBOUND_SCHEMA reference)
- Test helper `initTestSessionDb()`

### 2. PostToolUse hook didn't capture tool details

**Root cause**: The `postToolUseHook` callback ignored its `input` parameter.
The hook receives `tool_name` and `tool_input` (same shape as PreToolUse), but
the code discarded them.

**Fix**: Replaced the static `postToolUseHook` with `createPostToolUseHook(isFailure)`
factory that:
- Reads `tool_started_at` from `container_state` (written by PreToolUse)
- Captures tool_name and tool_input from the hook input
- Computes duration_ms
- Inserts into `tool_call_events`
- Then clears container_state as before

### 3. No /activity or /topology commands

**Root cause**: These commands didn't exist.

**Fix**: Added as host-intercepted commands in `command-gate.ts`:
- `/activity` — aggregates tool_call_events across all active sessions
- `/topology` — shows agent status with tool call counts
- Both admin-gated (same as /cost, /clear, etc.)
- Response written directly to outbound.db via `writeOutboundDirect`

### 4. Host couldn't read tool_call_events

**Root cause**: No query functions existed.

**Fix**: Added to `src/db/session-db.ts`:
- `getToolCallEvents(outDb, limit?)` — reads events from a session's outbound.db
- `countToolCallEvents(outDb)` — counts events for topology summary

## Verification

1. Send a message to CEO agent that triggers tool use (e.g., ask it to read a file)
2. Tool call logged in `data/v2-sessions/<agent_group_id>/<session_id>/outbound.db`
3. Run `/activity` — shows CEO tool usage with recent events
4. Run `/topology` — shows CEO agent status with non-zero tool count
