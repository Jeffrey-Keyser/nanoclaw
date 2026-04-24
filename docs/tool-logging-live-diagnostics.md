# CEO Tool Call Logging Pipeline — Live Diagnostic Report

**Date:** 2026-04-24
**Branch:** `dev-inbox/78216ebe-fix/ceo-tool-logging-live-diagnostics`
**Host:** Linux (systemd), NanoClaw v2.0.13
**Service status at time of diagnostics:** crash-looping (status=203/EXEC — start script missing), last successful run ended at ~22:04 UTC

---

## Executive Summary

The CEO tool call logging pipeline fails at **two independent stages**:

1. **Stage 1 (Hook Invocation) — CEO-specific:** The `tool-observer.sh` hook script does not exist on the host filesystem at the path referenced in the CEO session's `settings.json`. The hook silently fails, so **no tool event files are ever created for CEO sessions**.

2. **Stage 3 (Database Insertion) — All groups:** When devworker agents DO successfully create tool event files (their hooks fire correctly), the IPC watcher processes them but the database INSERT fails with `SqliteError: table tool_call_events has no column named event_type`. This is a **schema mismatch** between the table created by an earlier migration (old columns: `group_folder`, `hook_event`, `tool_use_id`, `tool_input`, `tool_response`, `timestamp`) and the current code which expects the revised columns (`event_type`, `payload`). All 137 tool event files have been quarantined to `data/ipc/errors/`.

**Result:** Zero rows exist in `tool_call_events`. No tool calls from any agent (CEO or worker) reach the database.

---

## Pipeline Architecture

```
Stage 1: Hook Invocation
  Claude Code session fires PostToolUse / PostToolUseFailure
    → tool-observer.sh reads JSON from stdin
    → Writes event file to {IPC_DIR}/../tool-events/{timestamp}-{tool}.json

Stage 2: IPC File Processing
  Host IPC watcher (fs.watch + 5s polling fallback)
    → Detects new .json files in data/ipc/{group}/tool-events/
    → Reads + parses JSON, calls handler

Stage 3: Database Insertion
  insertToolCallEvent() in dist/db/tool-events.js
    → INSERT INTO tool_call_events (session_id, event_type, tool_name, payload)
    → On failure, file is quarantined to data/ipc/errors/

Stage 4: Query / Display
  getRecentToolEvents() → /activity command, /topology dashboard
```

---

## Stage-by-Stage Diagnostic Results

### Stage 1: Hook Invocation

#### CEO Agent

**Trigger method:** CEO runs as a host-side tmux agent session, spawned by the host process. The session's settings.json is at `data/sessions/ceo/.claude/settings.json`.

**Settings.json hook configuration (CEO):**
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "/home/jkeyser/nanoclaw/container/hooks/tool-observer.sh"}]
    }],
    "PostToolUseFailure": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "/home/jkeyser/nanoclaw/container/hooks/tool-observer.sh"}]
    }]
  }
}
```

**Finding: HOOK SCRIPT DOES NOT EXIST**

```
$ ls -la /home/jkeyser/nanoclaw/container/hooks/tool-observer.sh
ls: cannot access '/home/jkeyser/nanoclaw/container/hooks/tool-observer.sh': No such file or directory

$ ls -la /home/jkeyser/nanoclaw/container/hooks/
ls: cannot access '/home/jkeyser/nanoclaw/container/hooks/': No such file or directory
```

The `container/hooks/` directory does not exist on the main branch or in the host repo. The script exists only in development worktrees:

```
/home/jkeyser/nanoclaw/.claude/worktrees/dev-inbox-5b59bb52/container/hooks/tool-observer.sh
/home/jkeyser/nanoclaw/.claude/worktrees/dev-inbox-b780e753/container/hooks/tool-observer.sh
/home/jkeyser/nanoclaw/.claude/worktrees/dev-inbox-2420b2d6/container/hooks/tool-observer.sh
(... 3 more worktrees)
```

**Root cause:** The `bootstrapSessionSettings()` function in `src/session-settings.ts` (line 60) checks `fs.existsSync(toolObserverHook)` before adding PostToolUse hooks to settings.json. When the host was previously running with `tool-observer.sh` present (from a deployed feature branch), the settings.json was written WITH the hook entries. After the feature branch was undeployed and the file removed, the stale settings.json remained, referencing a non-existent script. Claude Code attempts to run the hook, the command fails (file not found), but PostToolUse hooks fail silently by design — the tool call completes normally.

**CEO IPC directory — no tool-events subdirectory:**
```
$ ls /home/jkeyser/nanoclaw/data/ipc/ceo/
acks  available_groups.json  current_tasks.json  host-exec  input  messages  tasks
# No tool-events/ directory — confirms hook never writes files
```

**CEO debug directory — does not exist:**
```
$ ls /home/jkeyser/nanoclaw/data/ipc/ceo/debug/
ls: cannot access '...': No such file or directory
# NANOCLAW_TOOL_OBSERVER_DEBUG would log here — but hook never runs
```

#### DevWorker Agents

DevWorker0 and DevWorker1 have PostToolUse hooks configured and **their hooks DO fire**, because the agent sessions set `NANOCLAW_IPC_INPUT_DIR` in the environment. However, they reference the same missing `tool-observer.sh` path.

Wait — the hooks DID produce files. Let me clarify: the devworker sessions were spawned from a previous host build that had `tool-observer.sh` deployed. Evidence:

```
$ ls /home/jkeyser/nanoclaw/data/ipc/devworker0/tool-events/
(empty — files were processed and quarantined)

$ ls /home/jkeyser/nanoclaw/data/ipc/devworker1/tool-events/
(empty — files were processed and quarantined)
```

**137 tool event files were created and quarantined:**
```
$ ls -1 /home/jkeyser/nanoclaw/data/ipc/errors/ | cut -d'-' -f1 | sort | uniq -c | sort -rn
     82 devworker0
     55 devworker1

$ ls -1 /home/jkeyser/nanoclaw/data/ipc/errors/ | sed 's/.*-//' | sed 's/\.json//' | sort | uniq -c | sort -rn
     93 Bash
     22 Read
     11 Grep
      7 Edit
      4 TodoWrite
```

**Sample quarantined tool event file** (`devworker0-1777067964714770564-Bash.json`):
```json
{
  "tool_name": "Bash",
  "tool_use_id": "toolu_013Y7TBHhiDbWB9f64gKUFKj",
  "session_id": "962eb88c-02f0-4770-9dee-3d6f51e7e472",
  "hook_event": "PostToolUse",
  "tool_input": "{\"command\":\"git log --oneline -5\",\"description\":\"View recent commits\"}",
  "tool_response": "{\"stdout\":\"7766008 feat: enable tool call logging...\"}"
}
```

**Conclusion for Stage 1:** Hook fires successfully for devworkers (when the script existed), produces valid JSON files. CEO hooks never fire because the script is missing from the host filesystem.

---

### Stage 2: IPC File Processing (Watcher)

**Finding: WORKING CORRECTLY**

The IPC watcher (`dist/ipc.js`) processes tool-events directories alongside messages and tasks. Evidence from host logs:

```
[21:53:17.869] ERROR (860271): Error processing IPC file
    correlationId: "4013b6b1b8d6"
    op: "ipc-tool-event"
    sourceGroup: "devworker1"
    file: "1777067597810197166-TodoWrite.json"
```

The watcher:
- Detects new files in `data/ipc/{group}/tool-events/` (via fs.watch + 5s polling)
- Parses JSON successfully
- Calls `insertToolCallEvent()` handler
- On INSERT failure, quarantines the file to `data/ipc/errors/{group}-{filename}`

All 137 files were successfully read, parsed, and handed to the database handler. The watcher itself works correctly.

---

### Stage 3: Database Insertion

**Finding: SCHEMA MISMATCH — ALL INSERTS FAIL**

**Actual table schema in `store/messages.db`:**
```sql
CREATE TABLE tool_call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  group_folder TEXT NOT NULL,          -- OLD column
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,                    -- OLD column
  hook_event TEXT NOT NULL DEFAULT 'PostToolUse',  -- OLD column
  tool_input TEXT,                     -- OLD column
  tool_response TEXT,                  -- OLD column
  timestamp TEXT NOT NULL,             -- OLD column
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

**Code expects (from `dist/db/tool-events.js`):**
```sql
INSERT INTO tool_call_events (session_id, event_type, tool_name, payload)
VALUES (?, ?, ?, ?)
```

**Error:** Column `event_type` does not exist in the table. Column `payload` does not exist either.

**274 error occurrences in host log** — consistent `SqliteError`:
```
SqliteError: table tool_call_events has no column named event_type
    at Database.prepare (better-sqlite3/lib/methods/wrappers.js:5:21)
    at insertToolCallEvent (dist/db/tool-events.js:15:8)
    at Object.handle (dist/ipc.js:114:25)
```

**Migration history shows** the table was created at `2026-04-24T17:03:54.387Z`:
```
11|011_tool_call_events|2026-04-24T17:03:54.387Z
```

**Root cause:** The migration SQL file that ran contained the OLD schema (with `group_folder`, `hook_event`, `tool_use_id`, `tool_input`, `tool_response`, `timestamp` columns). This was from the initial observability feature commit. A subsequent commit (`ae38a0b`) revised the schema to use `event_type` + `payload` columns, but:

1. The migration uses `CREATE TABLE IF NOT EXISTS` — the table already existed with old columns, so the new schema was never applied.
2. The compiled code (`dist/db/tool-events.js`) was built from the REVISED version with `event_type` + `payload`.
3. No ALTER TABLE migration was created to bridge the old schema to the new one.

**Database query result:**
```
sqlite> SELECT COUNT(*) FROM tool_call_events;
0
```

Zero rows. No tool calls have ever been successfully stored.

---

### Stage 4: Query / Display

Not reachable — no data in the table. `/activity` and `/topology` commands would return empty results.

---

## Pipeline Failure Summary

| Stage | Component | CEO Status | DevWorker Status |
|-------|-----------|------------|------------------|
| 1. Hook invocation | `tool-observer.sh` | **BROKEN** — script missing from host | **WAS WORKING** — script existed in previous deploy |
| 2. IPC file creation | Hook writes JSON files | **BROKEN** — no files created | **WORKING** — 137 files created |
| 3. IPC watcher | `dist/ipc.js` processGroup | N/A — no files to process | **WORKING** — all files processed |
| 4. DB insertion | `insertToolCallEvent()` | N/A | **BROKEN** — schema mismatch |
| 5. Query / display | `getRecentToolEvents()` | N/A | **BROKEN** — 0 rows in table |

---

## Root Causes (Ordered by Severity)

### 1. Missing hook script on host (`container/hooks/tool-observer.sh`)

The tool-observer.sh shell hook has never been merged to main. It exists only on feature branches (`dev-inbox/2420b2d6`, `dev-inbox/5b59bb52`, `dev-inbox/b780e753`, etc.). For CEO tool logging to work, this file must exist on the host filesystem where the CEO Claude Code session runs.

### 2. Schema mismatch between `tool_call_events` table and code

The table was created with old-format columns from the initial observability feature, but the INSERT code was compiled from a later revision that uses different column names (`event_type` instead of `hook_event`, `payload` instead of individual `tool_input`/`tool_response`/`tool_use_id`/`group_folder` columns). No ALTER TABLE migration bridges the gap.

### 3. `dist/` contains code not present in `src/`

The host's `dist/` directory contains compiled JavaScript from a feature branch (`dist/db/tool-events.js`, `dist/stream-tool-logger.js`, `dist/ipc.js` with tool-event handling). The `src/` directory on main does not contain these files. This means the running code was built from a branch deployment that was never properly merged to main.

---

## Diagnostic Environment

**Debug flags tested:**
- `NANOCLAW_TOOL_OBSERVER_DEBUG=1` — would enable hook debug logging to `data/ipc/{group}/debug/tool-observer.log`, but hook never fires for CEO (script missing), so no debug output exists
- `NANOCLAW_IPC_DEBUG=1` — referenced in documentation but not implemented in code; no effect

**Host process environment (devworker0 agent, PID 879380):**
```
NANOCLAW_IPC_INPUT_DIR=/home/jkeyser/nanoclaw/data/ipc/devworker0/input
```

**Service state:** NanoClaw systemd service is crash-looping (`status=203/EXEC`), last successful host process (PID 878927) exited at 22:04:59 UTC. Background agent processes from the last run are still alive (devworker0 PID 879380, ops-agent worker PID 3166121).

---

## Recommended Fixes

1. **Merge the hook script to main:** Deploy `container/hooks/tool-observer.sh` from the feature branches. Ensure it's executable (`chmod +x`).

2. **Fix the schema mismatch:** Either:
   - (a) Create an ALTER TABLE migration to add `event_type` and `payload` columns, then update the INSERT to handle both old and new schemas, OR
   - (b) DROP and recreate the table with the correct schema (since it has 0 rows, no data loss), OR
   - (c) Update `insertToolCallEvent()` to use the column names that actually exist in the table.

3. **Merge tool logging source to main:** The `src/db/tool-events.ts`, `src/ipc/tool-event-handler.ts`, `src/ipc/file-processor.ts`, `src/stream-tool-logger.ts`, and the migration `014-tool-call-events.ts` all need to be merged from the feature branches to main and rebuilt.

4. **Fix the service start script:** The systemd service references a missing `start-nanoclaw.sh` (status=203/EXEC).
