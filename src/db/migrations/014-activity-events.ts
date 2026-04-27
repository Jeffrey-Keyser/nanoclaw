/**
 * Structured Activity Stream — central log of observable agent events.
 *
 * Distinct from the per-session `tool_call_events` table (which lives in
 * each session's outbound.db and is written directly by the container's
 * SDK PreToolUse/PostToolUse hooks). `activity_events` is the host-side
 * cross-session view, populated by:
 *   - host code paths that visibly choose a path (router → 'decision'
 *     events)
 *   - the host sweep mirroring per-session tool calls into a single
 *     queryable timeline
 *
 * Schema is freeform JSON in `payload` so future event_types can extend
 * without further migrations. The CHECK constrains the small set of
 * event_types the renderer + retention sweep know how to handle.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'activity-events',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        agent       TEXT NOT NULL,
        event_type  TEXT NOT NULL CHECK(event_type IN (
          'tool_call_start',
          'tool_call_complete',
          'reasoning_step',
          'decision'
        )),
        tool_name   TEXT,
        payload     TEXT NOT NULL,
        timestamp   INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      );

      CREATE INDEX IF NOT EXISTS idx_activity_events_session_ts
        ON activity_events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_activity_events_agent_ts
        ON activity_events(agent, timestamp DESC);
    `);
  },
};
