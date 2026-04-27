/**
 * Integration tests for the host-side activity-event read path:
 *
 *   - getToolCallEvents in chronological ASC order, including a mixed
 *     start/complete pair (acceptance criterion 6: "triggering a CEO
 *     action writes at least one tool_call_start/complete pair, and the
 *     activity reader returns them in chronological order").
 *   - sinceIso time-window filter.
 *   - deleteOldToolCallEvents 7-day retention.
 *
 * The container is the real writer in production; here we seed the same
 * outbound.db schema directly so the reader contract is exercised.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OUTBOUND_SCHEMA } from './schema.js';
import {
  countToolCallEvents,
  deleteOldToolCallEvents,
  getToolCallEvents,
  openOutboundDb,
  openOutboundDbWritable,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-tool-call-events-test';
const DB_PATH = path.join(TEST_DIR, 'outbound.db');

function seed(
  rows: Array<{
    id: string;
    event_type?: string;
    tool_name?: string | null;
    tool_input?: string | null;
    started_at: string;
    finished_at?: string;
    duration_ms?: number | null;
    error?: string | null;
  }>,
): void {
  const db = new Database(DB_PATH);
  db.exec(OUTBOUND_SCHEMA);
  const stmt = db.prepare(
    `INSERT INTO tool_call_events
       (id, event_type, tool_name, tool_input, started_at, finished_at, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      r.event_type ?? 'tool_call_complete',
      r.tool_name ?? 'Bash',
      r.tool_input ?? null,
      r.started_at,
      r.finished_at ?? r.started_at,
      r.duration_ms ?? null,
      r.error ?? null,
    );
  }
  db.close();
}

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('getToolCallEvents — chronological order', () => {
  it('returns a tool_call_start/complete pair in chronological order', () => {
    seed([
      { id: 'b', event_type: 'tool_call_complete', started_at: '2026-04-27T10:00:01.000Z' },
      { id: 'a', event_type: 'tool_call_start', started_at: '2026-04-27T10:00:00.000Z' },
    ]);

    const db = openOutboundDb(DB_PATH);
    try {
      const rows = getToolCallEvents(db);
      expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
      expect(rows[0].event_type).toBe('tool_call_start');
      expect(rows[1].event_type).toBe('tool_call_complete');
    } finally {
      db.close();
    }
  });

  it('limited query still returns the slice in chronological ASC order', () => {
    seed([
      { id: '1', started_at: '2026-04-27T10:00:00.000Z' },
      { id: '2', started_at: '2026-04-27T10:00:01.000Z' },
      { id: '3', started_at: '2026-04-27T10:00:02.000Z' },
    ]);

    const db = openOutboundDb(DB_PATH);
    try {
      const rows = getToolCallEvents(db, { limit: 2 });
      // Limit takes the most recent 2 (rows 2 and 3) but caller gets ASC.
      expect(rows.map((r) => r.id)).toEqual(['2', '3']);
    } finally {
      db.close();
    }
  });

  it('falls back to [] when the table is missing (older session DB)', () => {
    // No tool_call_events table at all — simulates an outbound.db produced
    // by an older container that hasn't run the new connection-bootstrap
    // code yet. The host reader must not throw.
    const dbPath = path.join(TEST_DIR, 'no-table.db');
    const empty = new Database(dbPath);
    empty.close();

    const reader = openOutboundDb(dbPath);
    try {
      expect(getToolCallEvents(reader)).toEqual([]);
      expect(getToolCallEvents(reader, { limit: 5 })).toEqual([]);
      expect(getToolCallEvents(reader, { sinceIso: '2026-04-27T00:00:00.000Z' })).toEqual([]);
    } finally {
      reader.close();
    }
  });
});

describe('getToolCallEvents — sinceIso time-window filter', () => {
  it('drops events before the cutoff', () => {
    seed([
      { id: 'old', started_at: '2026-04-27T09:00:00.000Z' },
      { id: 'new', started_at: '2026-04-27T11:30:00.000Z' },
    ]);

    const db = openOutboundDb(DB_PATH);
    try {
      const rows = getToolCallEvents(db, { sinceIso: '2026-04-27T10:00:00.000Z' });
      expect(rows.map((r) => r.id)).toEqual(['new']);
    } finally {
      db.close();
    }
  });

  it('returns empty array when the table is missing', () => {
    // No DB file written — reader sees no table.
    const dbPath = path.join(TEST_DIR, 'empty.db');
    const empty = new Database(dbPath);
    empty.close();
    const db = openOutboundDb(dbPath);
    try {
      expect(getToolCallEvents(db, { sinceIso: '2026-04-27T00:00:00.000Z' })).toEqual([]);
      expect(countToolCallEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('deleteOldToolCallEvents', () => {
  it('removes rows strictly older than the cutoff and returns the count', () => {
    seed([
      { id: 'old', started_at: '2026-04-19T00:00:00.000Z' },
      { id: 'edge', started_at: '2026-04-20T00:00:00.000Z' },
      { id: 'new', started_at: '2026-04-27T00:00:00.000Z' },
    ]);

    const db = openOutboundDbWritable(DB_PATH);
    try {
      const deleted = deleteOldToolCallEvents(db, '2026-04-20T00:00:00.000Z');
      expect(deleted).toBe(1);
    } finally {
      db.close();
    }

    const reader = openOutboundDb(DB_PATH);
    try {
      const remaining = getToolCallEvents(reader).map((r) => r.id);
      expect(remaining).toEqual(['edge', 'new']);
    } finally {
      reader.close();
    }
  });

  it('returns 0 when nothing matches', () => {
    seed([{ id: 'recent', started_at: '2026-04-27T00:00:00.000Z' }]);
    const db = openOutboundDbWritable(DB_PATH);
    try {
      expect(deleteOldToolCallEvents(db, '2020-01-01T00:00:00.000Z')).toBe(0);
    } finally {
      db.close();
    }
  });
});
