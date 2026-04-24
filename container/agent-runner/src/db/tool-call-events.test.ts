import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  initTestSessionDb,
  closeSessionDb,
  getOutboundDb,
  insertToolCallEvent,
} from './connection.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('tool_call_events', () => {
  it('inserts a tool call event and reads it back', () => {
    const now = new Date().toISOString();
    insertToolCallEvent({
      id: 'tc-1',
      toolName: 'Read',
      toolInput: JSON.stringify({ file_path: '/workspace/test.txt' }),
      startedAt: now,
      finishedAt: now,
      durationMs: 42,
      error: null,
    });

    const rows = getOutboundDb()
      .prepare('SELECT * FROM tool_call_events')
      .all() as Array<{
      id: string;
      tool_name: string;
      tool_input: string | null;
      started_at: string;
      finished_at: string;
      duration_ms: number | null;
      error: string | null;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tc-1');
    expect(rows[0].tool_name).toBe('Read');
    expect(rows[0].duration_ms).toBe(42);
    expect(rows[0].error).toBeNull();
  });

  it('records failure events', () => {
    const now = new Date().toISOString();
    insertToolCallEvent({
      id: 'tc-fail',
      toolName: 'Bash',
      toolInput: '{"command":"exit 1"}',
      startedAt: now,
      finishedAt: now,
      durationMs: 100,
      error: 'tool_use_failure',
    });

    const row = getOutboundDb()
      .prepare('SELECT error FROM tool_call_events WHERE id = ?')
      .get('tc-fail') as { error: string | null };

    expect(row.error).toBe('tool_use_failure');
  });

  it('INSERT OR IGNORE deduplicates by id', () => {
    const now = new Date().toISOString();
    const event = {
      id: 'tc-dup',
      toolName: 'Read',
      toolInput: null,
      startedAt: now,
      finishedAt: now,
      durationMs: 10,
      error: null,
    };

    insertToolCallEvent(event);
    insertToolCallEvent(event); // duplicate — should be ignored

    const count = (
      getOutboundDb().prepare('SELECT COUNT(*) AS c FROM tool_call_events').get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('handles null tool_input and duration_ms', () => {
    const now = new Date().toISOString();
    insertToolCallEvent({
      id: 'tc-null',
      toolName: 'WebSearch',
      toolInput: null,
      startedAt: now,
      finishedAt: now,
      durationMs: null,
      error: null,
    });

    const row = getOutboundDb()
      .prepare('SELECT tool_input, duration_ms FROM tool_call_events WHERE id = ?')
      .get('tc-null') as { tool_input: string | null; duration_ms: number | null };

    expect(row.tool_input).toBeNull();
    expect(row.duration_ms).toBeNull();
  });
});
