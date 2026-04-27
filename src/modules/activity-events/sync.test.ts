/**
 * End-to-end-ish test for the host sync that mirrors per-session
 * tool_call_events into central activity_events. Exercises the actual
 * cursor table and SQL paths — one in-memory central DB plus a
 * second in-memory DB that stands in for a session's outbound.db.
 *
 * Functional acceptance check: simulate a CEO tool invocation by
 * inserting a row into the per-session tool_call_events shape that the
 * container would have produced (PostToolUse hook), run the mirror,
 * and assert that exactly one tool_call_start + one tool_call_complete
 * row exist in central activity_events with the expected agent,
 * tool_name, and JSON payload shape.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migration014 } from '../../db/migrations/014-activity-events.js';
import { ActivityEventLogger } from './logger.js';
import { mirrorSessionToolCalls } from './sync.js';

let centralDb: Database.Database;
let outDb: Database.Database;

const SESSION_OUTBOUND_DDL = `
  CREATE TABLE tool_call_events (
    id          TEXT PRIMARY KEY,
    tool_name   TEXT NOT NULL,
    tool_input  TEXT,
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER,
    error       TEXT
  );
`;

beforeEach(() => {
  centralDb = new Database(':memory:');
  migration014.up(centralDb);

  outDb = new Database(':memory:');
  outDb.exec(SESSION_OUTBOUND_DDL);
});

afterEach(() => {
  centralDb.close();
  outDb.close();
});

function insertToolCall(
  id: string,
  toolName: string,
  toolInput: Record<string, unknown> | null,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
  error: string | null = null,
): void {
  outDb
    .prepare(
      `INSERT INTO tool_call_events (id, tool_name, tool_input, started_at, finished_at, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, toolName, toolInput ? JSON.stringify(toolInput) : null, startedAt, finishedAt, durationMs, error);
}

describe('mirrorSessionToolCalls', () => {
  it('produces tool_call_start + tool_call_complete pairs for a CEO tool invocation', () => {
    insertToolCall('tc1', 'Bash', { command: 'echo hi' }, '2026-04-27T10:00:00.000Z', '2026-04-27T10:00:00.150Z', 150);

    const mirrored = mirrorSessionToolCalls(centralDb, outDb, 'session-1', 'ceo');
    expect(mirrored).toBe(1);

    const logger = new ActivityEventLogger(centralDb);
    const rows = logger.queryRecent('ceo', 60 * 24 * 365, 50);
    expect(rows).toHaveLength(2);

    const start = rows.find((r) => r.event_type === 'tool_call_start')!;
    const complete = rows.find((r) => r.event_type === 'tool_call_complete')!;
    expect(start.agent).toBe('ceo');
    expect(start.tool_name).toBe('Bash');
    expect(complete.tool_name).toBe('Bash');

    const startPayload = JSON.parse(start.payload);
    expect(startPayload.args.command).toBe('echo hi');
    const completePayload = JSON.parse(complete.payload);
    expect(completePayload.duration_ms).toBe(150);

    expect(start.timestamp).toBeLessThan(complete.timestamp);
  });

  it('is idempotent — re-running mirror does not duplicate rows', () => {
    insertToolCall('tc1', 'Read', null, '2026-04-27T10:00:00.000Z', '2026-04-27T10:00:00.010Z', 10);

    expect(mirrorSessionToolCalls(centralDb, outDb, 's1', 'ceo')).toBe(1);
    expect(mirrorSessionToolCalls(centralDb, outDb, 's1', 'ceo')).toBe(0);

    const count = (centralDb.prepare('SELECT COUNT(*) AS c FROM activity_events').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('picks up new tool calls after the cursor', () => {
    insertToolCall('tc1', 'Read', null, '2026-04-27T10:00:00.000Z', '2026-04-27T10:00:00.010Z', 10);
    expect(mirrorSessionToolCalls(centralDb, outDb, 's1', 'ceo')).toBe(1);

    insertToolCall('tc2', 'Bash', null, '2026-04-27T10:01:00.000Z', '2026-04-27T10:01:00.020Z', 20);
    expect(mirrorSessionToolCalls(centralDb, outDb, 's1', 'ceo')).toBe(1);

    const total = (centralDb.prepare('SELECT COUNT(*) AS c FROM activity_events').get() as { c: number }).c;
    expect(total).toBe(4); // 2 tool calls × 2 events each
  });

  it('records errors in the complete payload', () => {
    insertToolCall('tc1', 'Bash', null, '2026-04-27T10:00:00.000Z', '2026-04-27T10:00:00.050Z', 50, 'tool_use_failure');
    mirrorSessionToolCalls(centralDb, outDb, 's1', 'ops');

    const logger = new ActivityEventLogger(centralDb);
    const rows = logger.queryRecent('ops', 60 * 24 * 365, 50);
    const complete = rows.find((r) => r.event_type === 'tool_call_complete')!;
    const parsed = JSON.parse(complete.payload);
    expect(parsed.error).toBe('tool_use_failure');
  });
});
