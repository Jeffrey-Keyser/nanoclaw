import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: '014-tool-call-events',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'PostToolUse',
        tool_name TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tool_events_session_created
        ON tool_call_events(session_id, created_at);
    `);
  },
};
