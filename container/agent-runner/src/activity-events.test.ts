import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { emitActivityEvent, redactSensitive, serializePayload, shouldRedactKey } from './activity-events.js';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';

beforeEach(() => {
  initTestSessionDb();
  delete process.env.ACTIVITY_AUTO_STREAM;
});

afterEach(() => {
  closeSessionDb();
});

describe('shouldRedactKey', () => {
  test('flags well-known credential keys', () => {
    expect(shouldRedactKey('authorization')).toBe(true);
    expect(shouldRedactKey('Authorization')).toBe(true);
    expect(shouldRedactKey('x-api-key')).toBe(true);
    expect(shouldRedactKey('apiKey')).toBe(true);
    expect(shouldRedactKey('Cookie')).toBe(true);
    expect(shouldRedactKey('set-cookie')).toBe(true);
    expect(shouldRedactKey('password')).toBe(true);
    expect(shouldRedactKey('access_token')).toBe(true);
  });

  test('leaves benign keys alone', () => {
    expect(shouldRedactKey('command')).toBe(false);
    expect(shouldRedactKey('url')).toBe(false);
    expect(shouldRedactKey('content')).toBe(false);
  });
});

describe('redactSensitive', () => {
  test('replaces sensitive values at any depth', () => {
    const input = {
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer SECRET',
        'X-Api-Key': 'key-123',
        'User-Agent': 'nanoclaw',
      },
      body: { password: 'hunter2', user: 'jeff' },
    };
    const out = redactSensitive(input) as Record<string, unknown>;
    const headers = out.headers as Record<string, unknown>;
    const body = out.body as Record<string, unknown>;
    expect(headers.Authorization).toBe('[REDACTED]');
    expect(headers['X-Api-Key']).toBe('[REDACTED]');
    expect(headers['User-Agent']).toBe('nanoclaw');
    expect(body.password).toBe('[REDACTED]');
    expect(body.user).toBe('jeff');
    expect(out.url).toBe('https://api.example.com');
  });

  test('handles arrays and primitives without crashing', () => {
    expect(redactSensitive(['a', 1, null, true])).toEqual(['a', 1, null, true]);
    expect(redactSensitive('plain string')).toBe('plain string');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBe(null);
  });

  test('caps recursion depth as defense-in-depth', () => {
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 32; i++) {
      const next: Record<string, unknown> = {};
      cur.next = next;
      cur = next;
    }
    // Should not throw; deeper levels collapse to the depth-cap marker.
    const out = JSON.stringify(redactSensitive(root));
    expect(out).toContain('depth-cap');
  });
});

describe('serializePayload', () => {
  test('returns null for null/undefined', () => {
    expect(serializePayload(null)).toBe(null);
    expect(serializePayload(undefined)).toBe(null);
  });

  test('truncates oversized payloads', () => {
    const huge = { blob: 'x'.repeat(10_000) };
    const out = serializePayload(huge);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(4097); // 4096 + ellipsis
    expect(out!.endsWith('…')).toBe(true);
  });
});

describe('emitActivityEvent — DB integration', () => {
  test('writes a tool_call_start row with redacted payload', () => {
    emitActivityEvent({
      eventType: 'tool_call_start',
      toolName: 'WebFetch',
      payload: { url: 'https://x.com', headers: { Authorization: 'Bearer secret' } },
    });

    const rows = getOutboundDb()
      .prepare('SELECT event_type, tool_name, tool_input FROM tool_call_events')
      .all() as Array<{ event_type: string; tool_name: string; tool_input: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('tool_call_start');
    expect(rows[0].tool_name).toBe('WebFetch');
    expect(rows[0].tool_input).toContain('[REDACTED]');
    expect(rows[0].tool_input).not.toContain('Bearer secret');
  });

  test('writes a decision row with no tool_name', () => {
    emitActivityEvent({
      eventType: 'decision',
      toolName: 'session_clear',
      payload: { summary: 'Session cleared by user' },
    });

    const row = getOutboundDb().prepare('SELECT event_type, tool_name, tool_input FROM tool_call_events').get() as {
      event_type: string;
      tool_name: string;
      tool_input: string;
    };

    expect(row.event_type).toBe('decision');
    expect(row.tool_name).toBe('session_clear');
    expect(row.tool_input).toContain('Session cleared by user');
  });

  test('records start/complete pair in chronological order', async () => {
    emitActivityEvent({
      eventType: 'tool_call_start',
      toolName: 'Bash',
      payload: { command: 'ls' },
      startedAt: '2026-04-27T10:00:00.000Z',
    });
    emitActivityEvent({
      eventType: 'tool_call_complete',
      toolName: 'Bash',
      payload: { command: 'ls' },
      startedAt: '2026-04-27T10:00:00.000Z',
      finishedAt: '2026-04-27T10:00:01.000Z',
      durationMs: 1000,
    });

    const rows = getOutboundDb()
      .prepare(
        'SELECT event_type, started_at, duration_ms FROM tool_call_events ORDER BY started_at ASC, event_type DESC',
      )
      .all() as Array<{ event_type: string; started_at: string; duration_ms: number | null }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].event_type).toBe('tool_call_start');
    expect(rows[1].event_type).toBe('tool_call_complete');
    expect(rows[1].duration_ms).toBe(1000);
  });

  test('fail-soft: never throws when the DB write fails', () => {
    // Close the DB so the next prepare() throws — emit must swallow it.
    closeSessionDb();

    expect(() =>
      emitActivityEvent({
        eventType: 'tool_call_start',
        toolName: 'Bash',
        payload: { command: 'echo hi' },
      }),
    ).not.toThrow();
  });
});

describe('emitActivityEvent — auto-stream gate', () => {
  test('does not write a messages_out row when ACTIVITY_AUTO_STREAM is unset', () => {
    emitActivityEvent({
      eventType: 'tool_call_start',
      toolName: 'Bash',
      payload: { command: 'ls' },
    });

    const count = (getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test('writes a broadcast messages_out row when enabled and routing is configured', () => {
    process.env.ACTIVITY_AUTO_STREAM = 'true';

    // Configure session_routing so the broadcast has a destination
    getOutboundDb()
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'telegram', '12345', NULL)`,
      )
      .run();

    emitActivityEvent({
      eventType: 'tool_call_start',
      toolName: 'Bash',
      payload: { command: 'ls' },
    });

    const broadcast = getOutboundDb().prepare('SELECT channel_type, platform_id, content FROM messages_out').get() as
      | { channel_type: string; platform_id: string; content: string }
      | undefined;

    expect(broadcast).toBeDefined();
    expect(broadcast!.channel_type).toBe('telegram');
    expect(broadcast!.platform_id).toBe('12345');
    expect(broadcast!.content).toContain('Bash');
  });

  test('does not broadcast tool_call_complete events even when enabled', () => {
    process.env.ACTIVITY_AUTO_STREAM = 'true';
    getOutboundDb()
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'telegram', '12345', NULL)`,
      )
      .run();

    emitActivityEvent({
      eventType: 'tool_call_complete',
      toolName: 'Bash',
      payload: {},
    });

    const count = (getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
