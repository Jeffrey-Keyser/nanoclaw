import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migration014 } from '../../db/migrations/014-activity-events.js';
import { ActivityEventLogger, PAYLOAD_MAX_BYTES } from './logger.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migration014.up(db);
});

afterEach(() => {
  db.close();
});

describe('ActivityEventLogger insert + queryRecent', () => {
  it('round-trips a tool_call_start event', () => {
    const logger = new ActivityEventLogger(db);
    logger.recordToolCallStart('s1', 'ceo', 'Bash', { args: { command: 'ls' } });

    const rows = logger.queryRecent('ceo', 5, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('tool_call_start');
    expect(rows[0]!.tool_name).toBe('Bash');
    expect(rows[0]!.session_id).toBe('s1');
    expect(rows[0]!.agent).toBe('ceo');
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.args.command).toBe('ls');
  });

  it('payload is stored as valid JSON', () => {
    const logger = new ActivityEventLogger(db);
    logger.recordDecision('s1', 'ops', { foo: 'bar', n: 42 });

    const rows = logger.queryRecent('ops', 5, 50);
    expect(() => JSON.parse(rows[0]!.payload)).not.toThrow();
    const parsed = JSON.parse(rows[0]!.payload);
    expect(parsed.foo).toBe('bar');
    expect(parsed.n).toBe(42);
  });

  it('preserves chronological ordering of tool_call_start events', () => {
    const logger = new ActivityEventLogger(db);
    const t0 = Date.now();
    logger.recordToolCallStart('s1', 'ceo', 'Read', {}, t0);
    logger.recordToolCallStart('s1', 'ceo', 'Bash', {}, t0 + 10);
    logger.recordToolCallStart('s1', 'ceo', 'Edit', {}, t0 + 20);

    const rows = logger.queryRecent('ceo', 5, 50);
    expect(rows.map((r) => r.tool_name)).toEqual(['Read', 'Bash', 'Edit']);
  });

  it('queryRecent honors sinceMinutes window', () => {
    const logger = new ActivityEventLogger(db);
    const now = Date.now();
    // 35 minutes ago — outside default 30-minute window
    logger.recordToolCallStart('s1', 'ceo', 'OldTool', {}, now - 35 * 60_000);
    // 5 minutes ago — inside window
    logger.recordToolCallStart('s1', 'ceo', 'NewTool', {}, now - 5 * 60_000);

    const rows = logger.queryRecent('ceo', 30, 50);
    expect(rows.map((r) => r.tool_name)).toEqual(['NewTool']);
  });

  it('queryRecent agent="*" returns all agents', () => {
    const logger = new ActivityEventLogger(db);
    logger.recordDecision('s1', 'ceo', { x: 1 });
    logger.recordDecision('s1', 'ops', { x: 2 });

    const rows = logger.queryRecent('*', 5, 50);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.agent))).toEqual(new Set(['ceo', 'ops']));
  });

  it('truncates oversized payloads with a marker', () => {
    const logger = new ActivityEventLogger(db);
    const huge = 'x'.repeat(PAYLOAD_MAX_BYTES * 5);
    logger.recordToolCallComplete('s1', 'ceo', 'Bash', { result: huge });

    const rows = logger.queryRecent('ceo', 5, 50);
    expect(rows[0]!.payload.length).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
    const parsed = JSON.parse(rows[0]!.payload);
    expect(parsed._truncated).toBe(true);
    expect(typeof parsed._preview).toBe('string');
  });

  it('redacts secrets before persisting', () => {
    const logger = new ActivityEventLogger(db);
    logger.recordToolCallStart('s1', 'ceo', 'Bash', {
      args: { headers: 'Authorization: Bearer abc-def-secret-123' },
    });
    const rows = logger.queryRecent('ceo', 5, 50);
    expect(rows[0]!.payload).not.toContain('abc-def-secret-123');
    expect(rows[0]!.payload).toContain('***REDACTED***');
  });

  it('insert failures do not throw to the caller', () => {
    const logger = new ActivityEventLogger(db);
    // Simulate a downstream DB failure by closing the handle.
    db.close();
    expect(() => logger.recordDecision('s1', 'ceo', { foo: 'bar' })).not.toThrow();
    // Re-open so afterEach close() doesn't throw
    db = new Database(':memory:');
    migration014.up(db);
  });

  it('CHECK constraint rejects unknown event_types', () => {
    // The public API only exposes known types — the failure is only
    // reachable by bypassing the API. We verify the table-level CHECK
    // here so a future surface bug doesn't silently corrupt the stream.
    expect(() =>
      db
        .prepare(
          `INSERT INTO activity_events (session_id, agent, event_type, payload, timestamp)
           VALUES ('s1', 'ceo', 'unknown_type', '{}', 0)`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
