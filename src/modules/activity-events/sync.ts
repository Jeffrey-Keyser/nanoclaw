/**
 * Mirror per-session `tool_call_events` (container-owned, in each session's
 * outbound.db) into the central `activity_events` table.
 *
 * Why a mirror and not a direct write from the container: the container has
 * no read/write access to the central DB by design (two-DB session split,
 * single-writer-per-file, cross-mount safety). The host sweep already
 * iterates active sessions every 60s; piggybacking on it gives us a single
 * cross-session view in `activity_events` without crossing the mount
 * boundary.
 *
 * Each tool_call_events row produces TWO activity_events rows:
 *   - tool_call_start  @ started_at
 *   - tool_call_complete @ finished_at
 * matching the event-type vocabulary the renderer + retention sweep know.
 *
 * Cursor: the maximum already-mirrored `started_at` per session. We can't
 * use the per-session row id because tool_call_events.id is a string
 * generated container-side; using `started_at` is monotonic-enough (the
 * SDK records it in PreToolUse before the host can read it). One row per
 * session is stored in `activity_events_cursor`.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { getToolCallEvents, type ToolCallEvent } from '../../db/session-db.js';
import { ActivityEventLogger } from './logger.js';

interface CursorRow {
  session_id: string;
  last_started_at: string;
}

function ensureCursorTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_events_cursor (
      session_id      TEXT PRIMARY KEY,
      last_started_at TEXT NOT NULL
    )
  `);
}

function getCursor(db: Database.Database, sessionId: string): string | null {
  ensureCursorTable(db);
  const row = db
    .prepare('SELECT session_id, last_started_at FROM activity_events_cursor WHERE session_id = ?')
    .get(sessionId) as CursorRow | undefined;
  return row?.last_started_at ?? null;
}

function setCursor(db: Database.Database, sessionId: string, lastStartedAt: string): void {
  db.prepare(
    `INSERT INTO activity_events_cursor (session_id, last_started_at)
     VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_started_at = excluded.last_started_at`,
  ).run(sessionId, lastStartedAt);
}

function summarizeInput(input: string | null): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    return parsed;
  } catch {
    return { raw: input };
  }
}

/**
 * Mirror new tool_call_events from one session into central activity_events.
 *
 * @param centralDb  central v2.db handle (writes activity_events rows)
 * @param outDb      session outbound.db handle (read-only is fine)
 * @param sessionId  session id (for cursor + activity_events.session_id)
 * @param agent      label that goes into activity_events.agent (typically
 *                   the agent_group name or id)
 * @returns number of tool_call_events rows mirrored (each produces two
 *          activity_events rows)
 */
export function mirrorSessionToolCalls(
  centralDb: Database.Database,
  outDb: Database.Database,
  sessionId: string,
  agent: string,
): number {
  const logger = new ActivityEventLogger(centralDb);
  let cursor: string | null;
  try {
    cursor = getCursor(centralDb, sessionId);
  } catch (err) {
    log.error('activity sync: cursor read failed', { sessionId, err });
    return 0;
  }

  const all = getToolCallEvents(outDb);
  if (all.length === 0) return 0;

  const fresh: ToolCallEvent[] = cursor ? all.filter((r) => r.started_at > cursor!) : all;
  if (fresh.length === 0) return 0;

  let lastStartedAt = cursor ?? '';
  for (const ev of fresh) {
    const startMs = Date.parse(ev.started_at);
    const finishMs = Date.parse(ev.finished_at);
    const startTs = Number.isFinite(startMs) ? startMs : Date.now();
    const finishTs = Number.isFinite(finishMs) ? finishMs : startTs;

    logger.recordToolCallStart(
      sessionId,
      agent,
      ev.tool_name,
      { args: summarizeInput(ev.tool_input) },
      startTs,
    );
    logger.recordToolCallComplete(
      sessionId,
      agent,
      ev.tool_name,
      {
        duration_ms: ev.duration_ms,
        ...(ev.error ? { error: ev.error } : {}),
      },
      finishTs,
    );

    if (ev.started_at > lastStartedAt) lastStartedAt = ev.started_at;
  }

  if (lastStartedAt && lastStartedAt !== cursor) {
    try {
      setCursor(centralDb, sessionId, lastStartedAt);
    } catch (err) {
      log.error('activity sync: cursor write failed', { sessionId, err });
    }
  }
  return fresh.length;
}
