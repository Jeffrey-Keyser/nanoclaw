# Dispatch Events Implementation Plan

**Task ID:** 5133abbb-0db5-4e6c-b76d-4b3d9d0a2e7c
**Created by:** CEO (under duress - Agency HQ down, cannot delegate)
**For:** Engineering Lead to complete

## Overview

Add structured event logging to the dispatch loop to provide observability into dispatch decisions and enable replay/debugging of failed tasks.

## Database Schema

### New Table: `dispatch_events`

```sql
CREATE TABLE dispatch_events (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT,
  task_id TEXT NOT NULL,
  slot_id TEXT,
  agent_backend TEXT,
  model TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  stdout_bytes INTEGER,
  stderr_bytes INTEGER,
  stderr_tail VARCHAR(4096),
  retry_ordinal INTEGER,
  disposition TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dispatch_id) REFERENCES dispatch_runs(id)
);

CREATE INDEX idx_dispatch_events_task_created
  ON dispatch_events(task_id, created_at DESC);
```

## Event Types

Based on the dispatch loop state machine, events should be emitted at these points:

1. **slot_claimed** - Slot successfully claimed for a task
2. **slot_claim_failed** - Could not claim slot (race condition or all busy)
3. **task_skipped** - Task skipped (branch conflict, dependencies, etc.)
4. **execution_started** - Container process started
5. **execution_completed** - Container process exited (any exit code)
6. **execution_timeout** - Container killed after timeout
7. **result_writeback** - Results written back to Agency HQ
8. **slot_released** - Slot freed for next task

## Implementation Files

### 1. Migration: `migrations/NNNNNNNNNNNN-create-dispatch-events.ts`

Create new migration following existing pattern in `migrations/` directory.

### 2. Database Functions: `src/db/dispatch-events.ts`

```typescript
export interface DispatchEvent {
  id: string;
  dispatch_id?: string;
  task_id: string;
  slot_id?: string;
  agent_backend?: string;
  model?: string;
  exit_code?: number;
  duration_ms?: number;
  stdout_bytes?: number;
  stderr_bytes?: number;
  stderr_tail?: string;
  retry_ordinal?: number;
  disposition: string;
  created_at: string;
}

export async function logDispatchEvent(event: Omit<DispatchEvent, 'id' | 'created_at'>): Promise<void>
export async function getTaskEvents(taskId: string): Promise<DispatchEvent[]>
export async function cleanupOldEvents(daysToKeep: number): Promise<number>
```

### 3. Dispatch Loop Integration: `src/dispatch-loop.ts`

Add event logging calls at key points:

- After `claimSlot()` success/failure
- Before/after container spawn
- After container exit
- After result write-back to Agency HQ
- After slot release

Example:
```typescript
const claimed = await claimSlot(task.id, slotId);
if (claimed) {
  await logDispatchEvent({
    task_id: task.id,
    slot_id: slotId,
    disposition: 'slot_claimed',
    retry_ordinal: task.retry_count || 0
  });
} else {
  await logDispatchEvent({
    task_id: task.id,
    disposition: 'slot_claim_failed'
  });
}
```

### 4. Cleanup Job: `src/cleanup-dispatch-events.ts`

Create a standalone script that runs nightly via cron/systemd timer:

```typescript
import { cleanupOldEvents } from './db/dispatch-events.js';

const ttlDays = parseInt(process.env.DISPATCH_EVENT_TTL_DAYS || '30');
const deleted = await cleanupOldEvents(ttlDays);
console.log(`Cleaned up ${deleted} dispatch events older than ${ttlDays} days`);
```

### 5. Tests: `src/dispatch-events.test.ts`

Test coverage:
- Each event type is logged correctly
- Events survive restarts (persistent)
- Cleanup job respects TTL
- No performance regression (<50ms per write)
- Index is used for task_id queries

## Performance Constraints

**Requirement: <50ms per event write**

Strategies:
- Use prepared statements (already in db.ts pattern)
- Write events asynchronously (don't block dispatch loop)
- Batch writes if multiple events happen in quick succession
- Consider write-ahead log if performance is still an issue

## Configuration

Add to `.env`:
```
DISPATCH_EVENT_TTL_DAYS=30  # How long to keep events before cleanup
```

## Cron/Systemd Timer

Add to systemd user timer or crontab:
```
0 2 * * * cd /home/jkeyser/dev-inbox && node dist/cleanup-dispatch-events.js
```

## Testing Strategy

1. **Unit tests**: Each logDispatchEvent call in dispatch-loop.ts
2. **Integration test**: Full dispatch cycle logs all expected events
3. **Performance test**: Measure write latency over 1000 events
4. **Cleanup test**: Verify old events are deleted correctly

## Validation

After implementation, verify:
- [ ] All 8 event types are emitted during a normal dispatch cycle
- [ ] Events table has composite index on (task_id, created_at DESC)
- [ ] Cleanup job runs and deletes old events
- [ ] No performance regression in dispatch loop (benchmark before/after)
- [ ] stderr_tail is truncated to 4096 chars
- [ ] Events persist across NanoClaw restarts

## Open Questions for Engineering

1. Should we add event logging to `agency-hq-dispatcher.ts` as well, or just `dispatch-loop.ts`?
2. Should events be written synchronously (blocking) or async (fire-and-forget)?
3. Do we need a separate `dispatch_runs` table to group events by dispatch tick, or is `dispatch_id` optional?
4. Should the cleanup job also archive events to S3/file before deleting?

## Status

**CEO BLOCKED** - Cannot implement due to role constraints. Handing off to Engineering Lead.

When Agency HQ is restored:
1. Assign to Engineering Lead
2. Move to `in-progress`
3. Execute implementation following this plan
4. Write back result to Agency HQ when complete
