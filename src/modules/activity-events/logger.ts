/**
 * ActivityEventLogger — host-side writer for the structured activity stream.
 *
 * Holds no global state; callers pass the central `Database` handle they
 * already own. Writes are synchronous (better-sqlite3 INSERT) and wrapped
 * in try/catch so a logging failure never propagates back into agent code
 * paths. Failures fall through to stderr via the shared `log` helper.
 *
 * Payloads are JSON-stringified at insert time, redacted, and truncated to
 * a fixed cap so the table can't balloon from one runaway tool call. The
 * truncated form is marked with `_truncated: true` so renderers can show
 * an indicator instead of silently lying about the data.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { redactSecrets } from './redact.js';

export type ActivityAgent = string;
export type ActivityEventType = 'tool_call_start' | 'tool_call_complete' | 'reasoning_step' | 'decision';

export interface ActivityEventRow {
  id: number;
  session_id: string;
  agent: string;
  event_type: ActivityEventType;
  tool_name: string | null;
  payload: string;
  timestamp: number;
}

/** Max bytes we'll keep in the JSON payload column. Matches ~500 char target
 *  in the task spec with headroom for the truncation marker / JSON quoting. */
export const PAYLOAD_MAX_BYTES = 800;

function encodePayload(raw: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(raw ?? {});
  } catch {
    json = '{}';
  }
  const redacted = redactSecrets(json);

  if (redacted.length <= PAYLOAD_MAX_BYTES) return redacted;

  // Strategy: re-encode as { _truncated: true, _preview: "...first N chars..." }
  // so callers always get parseable JSON back, regardless of what `raw` was.
  const previewLen = Math.max(0, PAYLOAD_MAX_BYTES - 64);
  const preview = redacted.slice(0, previewLen);
  return JSON.stringify({ _truncated: true, _preview: preview });
}

export class ActivityEventLogger {
  private readonly db: Database.Database;
  private insertStmt: Database.Statement | null = null;
  private queryStmt: Database.Statement | null = null;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private getInsertStmt(): Database.Statement {
    if (!this.insertStmt) {
      this.insertStmt = this.db.prepare(
        `INSERT INTO activity_events (session_id, agent, event_type, tool_name, payload, timestamp)
         VALUES (@session_id, @agent, @event_type, @tool_name, @payload, @timestamp)`,
      );
    }
    return this.insertStmt;
  }

  private write(row: {
    session_id: string;
    agent: string;
    event_type: ActivityEventType;
    tool_name: string | null;
    payload: unknown;
    timestamp?: number;
  }): void {
    try {
      this.getInsertStmt().run({
        session_id: row.session_id,
        agent: row.agent,
        event_type: row.event_type,
        tool_name: row.tool_name,
        payload: encodePayload(row.payload),
        timestamp: row.timestamp ?? Date.now(),
      });
    } catch (err) {
      log.error('ActivityEventLogger: insert failed (swallowed)', {
        event_type: row.event_type,
        agent: row.agent,
        err,
      });
    }
  }

  recordToolCallStart(
    sessionId: string,
    agent: string,
    toolName: string,
    payload: Record<string, unknown> = {},
    timestamp?: number,
  ): void {
    this.write({
      session_id: sessionId,
      agent,
      event_type: 'tool_call_start',
      tool_name: toolName,
      payload,
      timestamp,
    });
  }

  recordToolCallComplete(
    sessionId: string,
    agent: string,
    toolName: string,
    payload: Record<string, unknown> = {},
    timestamp?: number,
  ): void {
    this.write({
      session_id: sessionId,
      agent,
      event_type: 'tool_call_complete',
      tool_name: toolName,
      payload,
      timestamp,
    });
  }

  recordReasoningStep(sessionId: string, agent: string, payload: Record<string, unknown> = {}, timestamp?: number): void {
    this.write({
      session_id: sessionId,
      agent,
      event_type: 'reasoning_step',
      tool_name: null,
      payload,
      timestamp,
    });
  }

  recordDecision(sessionId: string, agent: string, payload: Record<string, unknown> = {}, timestamp?: number): void {
    this.write({
      session_id: sessionId,
      agent,
      event_type: 'decision',
      tool_name: null,
      payload,
      timestamp,
    });
  }

  /**
   * Recent events for `agent` within `sinceMinutes` minutes, oldest-first.
   * Returns at most `limit` rows. Pass `agent` = `'*'` (or empty) to query
   * across all agents.
   */
  queryRecent(agent: string, sinceMinutes: number, limit: number): ActivityEventRow[] {
    const sinceMs = Date.now() - sinceMinutes * 60_000;
    try {
      if (!this.queryStmt || agent === '*' || !agent) {
        // The "all agents" path uses a different SQL — don't cache it under
        // the same statement slot.
        if (agent === '*' || !agent) {
          return this.db
            .prepare(
              `SELECT id, session_id, agent, event_type, tool_name, payload, timestamp
                 FROM activity_events
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
                LIMIT ?`,
            )
            .all(sinceMs, limit) as ActivityEventRow[];
        }
        this.queryStmt = this.db.prepare(
          `SELECT id, session_id, agent, event_type, tool_name, payload, timestamp
             FROM activity_events
            WHERE agent = ? AND timestamp >= ?
            ORDER BY timestamp ASC
            LIMIT ?`,
        );
      }
      return this.queryStmt.all(agent, sinceMs, limit) as ActivityEventRow[];
    } catch (err) {
      log.error('ActivityEventLogger: query failed', { agent, sinceMinutes, err });
      return [];
    }
  }
}
