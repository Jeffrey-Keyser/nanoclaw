# Tool Logging Troubleshooting Guide

Comprehensive guide for diagnosing failures in the tool call logging pipeline. Tool logging captures every tool invocation (Bash, Read, Write, etc.) from all agent types and stores them in the `tool_call_events` SQLite table.

## Architecture Overview

There are **two independent pipelines** depending on the agent type:

### Pipeline A: Hook-based (containerized agents — CEO, workers)

```
Claude Code session
    ↓
PostToolUse hook fires
    ↓
tool-observer.sh (reads JSON from stdin)
    ↓
writes JSON file to ipc/{group}/tool-events/
    ↓
IPC watcher detects file (fs.watch + polling)
    ↓
processJsonIpcDirectory() reads & deletes file
    ↓
insertToolCallEvent() → SQLite
```

### Pipeline B: Stream-based (host-side agents — ops-agent)

```
Claude CLI spawned with --output-format stream-json
    ↓
stdout emits tool_use + tool_result JSON lines
    ↓
StreamToolLogger.processLine() parses each line
    ↓
pairs tool_use with tool_result by tool_use_id
    ↓
insertToolCallEvent() → SQLite
```

## Key Files

| File | Role |
|------|------|
| `container/hooks/tool-observer.sh` | Shell hook that captures PostToolUse events |
| `src/session-settings.ts` | Bootstraps `.claude/settings.json` with hook config |
| `src/container-runner.ts` | Creates IPC directories and passes env vars |
| `src/ipc.ts` | Watches IPC dirs, processes tool event files |
| `src/ipc/file-processor.ts` | Generic JSON file processor |
| `src/stream-tool-logger.ts` | Parses stream-json output for host-side agents |
| `src/ops-agent/worker.ts` | Ops agent with StreamToolLogger integration |
| `src/db/tool-events.ts` | Database insert/query/prune functions |
| `migrations/011_tool_call_events.sql` | Schema definition |

## Common Failure Modes

### 1. `bootstrapOpsToolLogging()` does not exist

The task description may reference `bootstrapOpsToolLogging()` — this function was **never implemented**. The ops-agent uses `StreamToolLogger` instead, which parses `--output-format stream-json` output directly. This is by design: host-side agents don't use PostToolUse hooks because they run the CLI directly (not through Claude Code's settings.json hook system).

**Resolution:** No action needed. The ops-agent tool logging path is:
- `src/ops-agent/worker.ts` creates `new StreamToolLogger('ops-agent')`
- Stdout is parsed line-by-line via `toolLogger.processLine(line)`
- Tool events are logged directly to SQLite without IPC files

### 2. tool-observer.sh not executable

**Symptom:** No tool event files appear in `ipc/{group}/tool-events/`.

**Check:**
```bash
ls -la container/hooks/tool-observer.sh
# Should show -rwxrwxr-x (executable)
```

**Fix:**
```bash
chmod +x container/hooks/tool-observer.sh
```

### 3. NANOCLAW_IPC_INPUT_DIR not set in spawned process

**Symptom:** tool-observer.sh falls back to `/workspace/ipc/input` (Docker default path) instead of the correct host path.

**How it's set:** `buildSessionEnv()` in `src/session-settings.ts` maps the `/workspace/ipc` mount to `NANOCLAW_IPC_INPUT_DIR = path.join(hostPath, 'input')`.

**Verification:**
```bash
# Check if the env var is in the tmux session's environment
tmux show-environment -t nanoclaw-<group>-<ts> | grep NANOCLAW_IPC_INPUT_DIR
```

**Debug logging:** With `LOG_LEVEL=debug`, look for:
```
Session environment built for agent { CLAUDE_CONFIG_DIR: ..., NANOCLAW_IPC_INPUT_DIR: ... }
```

### 4. CLAUDE_CONFIG_DIR not set or pointing to wrong directory

**Symptom:** Claude Code doesn't find the settings.json with PostToolUse hooks.

**How it's set:** `buildSessionEnv()` maps the `/home/node/.claude` mount to `CLAUDE_CONFIG_DIR`.

**Where settings.json lives:**
```
DATA_DIR/sessions/{group}/.claude/settings.json
```

**Verification:**
```bash
cat DATA_DIR/sessions/{group}/.claude/settings.json | jq '.hooks'
# Should show PostToolUse and PostToolUseFailure entries
```

### 5. PostToolUse hooks not configured in settings.json

**Symptom:** `settings.json` exists but has no `hooks` section.

**How it's configured:** `bootstrapSessionSettings()` in `src/session-settings.ts` writes hooks only if `container/hooks/tool-observer.sh` exists on disk.

**Debug logging:** With `LOG_LEVEL=debug`, look for:
```
Configured PostToolUse hooks for tool-observer { groupFolder: ..., toolObserverHook: ... }
```

Or the warning:
```
tool-observer.sh not found, PostToolUse hooks will not be configured
```

**Fix:** Ensure `container/hooks/tool-observer.sh` exists and is executable. Then delete the stale settings.json to force re-creation:
```bash
rm DATA_DIR/sessions/{group}/.claude/settings.json
# Restart NanoClaw — bootstrapSessionSettings will recreate it
```

### 6. jq not installed in the execution environment

**Symptom:** tool-observer.sh runs but produces empty/invalid JSON files.

**Check:**
```bash
which jq
jq --version
```

**Note:** The script redirects jq stderr to `/dev/null` (`2>/dev/null`), which silently swallows errors. Enable debug mode to see failures.

### 7. IPC watcher not detecting new files

**Symptom:** Tool event JSON files accumulate in `ipc/{group}/tool-events/` but are never processed.

**Checks:**
- Verify the IPC watcher is running: look for `IPC watcher started with fs.watch` in startup logs
- Check that `DATA_DIR/ipc/` is the correct base directory
- Look for `Error reading IPC tool-events directory` error messages
- The IPC watcher uses `fs.watch` (recursive) with a fallback poll interval — check `IPC_FALLBACK_POLL_INTERVAL` in config

### 8. Tool event file has missing fields

**Symptom:** `Skipping tool event with missing fields` warning in logs.

**Cause:** The tool-observer.sh hook receives JSON from Claude Code's hook system. If `session_id` or `tool_name` is missing from the stdin payload, the event is skipped.

**Debug:** Enable tool-observer debug mode and check the raw input:
```bash
export NANOCLAW_TOOL_OBSERVER_DEBUG=1
# Then check: ipc/{group}/debug/tool-observer.log
```

### 9. StreamToolLogger not receiving session_id

**Symptom:** `StreamToolLogger` captures tool_use events but never logs them because `this.sessionId` is null.

**Cause:** The `system/init` message with `session_id` must arrive before any `tool_use`/`tool_result` pairs. If the CLI doesn't emit a system/init message (e.g., non-Claude provider), tool logging silently fails.

**Verification:** With `LOG_LEVEL=debug`, check for:
```
StreamToolLogger: session ID extracted from init message { sessionId: ... }
StreamToolLogger: tracking tool_use { toolId: ..., toolName: ... }
```

If you see `tracking tool_use` but no `session ID extracted`, the CLI isn't emitting the init message.

### 10. Database not initialized

**Symptom:** `insertToolCallEvent()` throws because the `tool_call_events` table doesn't exist.

**Check:**
```bash
sqlite3 DATA_DIR/nanoclaw.db ".tables" | grep tool_call_events
```

**Fix:** Ensure migration `011_tool_call_events.sql` has been applied. The database is initialized on startup in `lifecycle.ts` → `initDatabase()`.

## Enabling Debug Mode

### Application-level debug logging

Set `LOG_LEVEL=debug` in your `.env` file or environment:
```bash
LOG_LEVEL=debug systemctl --user restart nanoclaw
```

This enables debug output for:
- `src/session-settings.ts` — hook configuration and env var setup
- `src/container-runner.ts` — IPC directory creation
- `src/ipc.ts` — tool event file processing
- `src/stream-tool-logger.ts` — stream parsing and tool event pairing

### Shell hook debug logging

Set `NANOCLAW_TOOL_OBSERVER_DEBUG=1` to enable per-invocation logging in tool-observer.sh:

```bash
# Add to the agent's environment (in session-settings.ts or .env)
NANOCLAW_TOOL_OBSERVER_DEBUG=1
```

Debug logs are written to `ipc/{group}/debug/tool-observer.log` and include:
- Timestamp of each hook invocation
- Tool name and event type
- `NANOCLAW_IPC_INPUT_DIR` and `CLAUDE_CONFIG_DIR` values
- Input payload length
- Whether the output file was successfully written

## Verification Checklist

Use this checklist to verify the full pipeline end-to-end:

### Hook-based pipeline (CEO/workers)

- [ ] `container/hooks/tool-observer.sh` exists and is executable (`chmod +x`)
- [ ] `settings.json` at `DATA_DIR/sessions/{group}/.claude/settings.json` contains `hooks.PostToolUse` and `hooks.PostToolUseFailure`
- [ ] Hook command path in settings.json points to the correct absolute path of `tool-observer.sh`
- [ ] `CLAUDE_CONFIG_DIR` env var is set in the spawned tmux session and points to `DATA_DIR/sessions/{group}/.claude`
- [ ] `NANOCLAW_IPC_INPUT_DIR` env var is set and points to `DATA_DIR/ipc/{group}/input`
- [ ] `ipc/{group}/tool-events/` directory exists
- [ ] `jq` is available in the execution environment
- [ ] IPC watcher is running (check startup log for `IPC watcher started`)
- [ ] Tool event files appear in `ipc/{group}/tool-events/` after hook fires
- [ ] Files are consumed (deleted) by the IPC watcher after processing
- [ ] `tool_call_events` table contains new rows

### Stream-based pipeline (ops-agent)

- [ ] Ops-agent uses `--output-format stream-json` flag (Claude provider only)
- [ ] `StreamToolLogger` is instantiated with correct group folder (`'ops-agent'`)
- [ ] CLI emits `{"type":"system","subtype":"init","session_id":"..."}` line
- [ ] `tool_use` and `tool_result` messages appear in stream output
- [ ] `tool_call_events` table contains new rows with `group_folder='ops-agent'`

## Querying Tool Events

```sql
-- Recent events (last 5 minutes)
SELECT * FROM tool_call_events
WHERE created_at >= datetime('now', '-5 minutes')
ORDER BY created_at DESC, id DESC
LIMIT 100;

-- Events by group
SELECT * FROM tool_call_events
WHERE json_extract(payload, '$.group_folder') = 'ceo'
ORDER BY created_at DESC;

-- Event count by tool name
SELECT tool_name, COUNT(*) as count
FROM tool_call_events
GROUP BY tool_name
ORDER BY count DESC;
```
