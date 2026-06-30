import Database from 'better-sqlite3';

let db: Database.Database;

/** @internal */
export function _setToolEventsDb(database: Database.Database): void {
  db = database;
}

export interface ToolCallEvent {
  id: number;
  session_id: string;
  event_type: string;
  tool_name: string;
  payload: string | null;
  created_at: string;
}

/**
 * Stable read-only tool event contract consumed by Agency HQ.
 *
 * Keep these request/response fields storage-agnostic. Agency HQ should not
 * need to know NanoClaw's SQLite table names, hook payload shape, or retention
 * implementation details.
 */
export interface ToolEventsQuery {
  since?: string;
  limit?: number;
  sessionId?: string;
  groupFolder?: string;
  taskId?: string;
  runId?: string;
  eventType?: string;
}

export interface AgencyHqToolEvent {
  id: string;
  occurredAt: string;
  sessionId: string;
  groupFolder: string | null;
  taskId: string | null;
  runId: string | null;
  eventType: string;
  toolName: string;
  toolUseId: string | null;
  input: string | null;
  response: string | null;
}

export interface ToolEventsResponse {
  events: AgencyHqToolEvent[];
  limit: number;
}

export interface InsertToolCallEvent {
  session_id: string;
  event_type: string;
  tool_name: string;
  payload?: Record<string, unknown>;
}

const MAX_PAYLOAD_LENGTH = 4096;

export function insertToolCallEvent(event: InsertToolCallEvent): void {
  let payloadStr: string | null = null;
  if (event.payload) {
    payloadStr = JSON.stringify(event.payload);
    if (payloadStr.length > MAX_PAYLOAD_LENGTH) {
      payloadStr = payloadStr.slice(0, MAX_PAYLOAD_LENGTH);
    }
  }

  db.prepare(
    `INSERT INTO tool_call_events (session_id, event_type, tool_name, payload)
     VALUES (?, ?, ?, ?)`,
  ).run(event.session_id, event.event_type, event.tool_name, payloadStr);
}

/**
 * Get recent tool call events, defaulting to last 5 minutes.
 * Uses SQLite's datetime() for comparison since created_at uses SQLite format.
 */
export function getRecentToolEvents(
  minutesAgo: number = 5,
  limit: number = 100,
): ToolCallEvent[] {
  return db
    .prepare(
      `SELECT id, session_id, event_type, tool_name, payload, created_at
       FROM tool_call_events
       WHERE created_at >= datetime('now', ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(`-${minutesAgo} minutes`, limit) as ToolCallEvent[];
}

const DEFAULT_TOOL_EVENTS_LIMIT = 100;
const MAX_TOOL_EVENTS_LIMIT = 500;

function normalizeCreatedAt(value: string): string {
  if (value.includes('T')) {
    return value.endsWith('Z') ? value : `${value}Z`;
  }

  return `${value.replace(' ', 'T')}Z`;
}

function getPayloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function parsePayload(payload: string | null): Record<string, unknown> {
  if (!payload) {
    return {};
  }

  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeToolEvent(row: ToolCallEvent): AgencyHqToolEvent {
  const payload = parsePayload(row.payload);

  return {
    id: String(row.id),
    occurredAt: normalizeCreatedAt(row.created_at),
    sessionId: row.session_id,
    groupFolder: getPayloadString(payload, 'group_folder'),
    taskId: getPayloadString(payload, 'task_id'),
    runId: getPayloadString(payload, 'run_id'),
    eventType: row.event_type,
    toolName: row.tool_name,
    toolUseId: getPayloadString(payload, 'tool_use_id'),
    input: getPayloadString(payload, 'tool_input'),
    response: getPayloadString(payload, 'tool_response'),
  };
}

export function normalizeToolEventsLimit(limit?: number): number {
  if (limit === undefined) {
    return DEFAULT_TOOL_EVENTS_LIMIT;
  }

  return Math.min(limit, MAX_TOOL_EVENTS_LIMIT);
}

/**
 * Query the stable Agency HQ tool-events read model.
 */
export function listToolEventsForAgencyHq(
  query: ToolEventsQuery = {},
): ToolEventsResponse {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.since) {
    clauses.push('created_at >= datetime(?)');
    params.push(query.since);
  }

  if (query.sessionId) {
    clauses.push('session_id = ?');
    params.push(query.sessionId);
  }

  if (query.eventType) {
    clauses.push('event_type = ?');
    params.push(query.eventType);
  }

  if (query.groupFolder) {
    clauses.push(
      "json_valid(payload) AND json_extract(payload, '$.group_folder') = ?",
    );
    params.push(query.groupFolder);
  }

  if (query.taskId) {
    clauses.push(
      "json_valid(payload) AND json_extract(payload, '$.task_id') = ?",
    );
    params.push(query.taskId);
  }

  if (query.runId) {
    clauses.push(
      "json_valid(payload) AND json_extract(payload, '$.run_id') = ?",
    );
    params.push(query.runId);
  }

  const limit = normalizeToolEventsLimit(query.limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id, session_id, event_type, tool_name, payload, created_at
       FROM tool_call_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as ToolCallEvent[];

  return {
    events: rows.map(normalizeToolEvent),
    limit,
  };
}

/**
 * Delete tool call events older than the given retention period.
 */
export function pruneToolEvents(retentionDays: number = 7): number {
  const result = db
    .prepare(
      `DELETE FROM tool_call_events WHERE created_at < datetime('now', ?)`,
    )
    .run(`-${retentionDays} days`);
  return result.changes;
}
