import Database from 'better-sqlite3';

let db: Database.Database;

/** @internal */
export function _setAgentEventsDb(database: Database.Database): void {
  db = database;
}

export type AgentEventDeliveryMode = 'channel' | 'capture';
export type AgentEventStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AgentEvent {
  id: string;
  recipient: string;
  execution_jid: string;
  source: string;
  delivery_mode: AgentEventDeliveryMode;
  status: AgentEventStatus;
  execution_id: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function insertAgentEvent(event: {
  id: string;
  recipient: string;
  executionJid: string;
  source: string;
  deliveryMode: AgentEventDeliveryMode;
  createdAt: string;
}): void {
  db.prepare(
    `INSERT INTO agent_events
       (id, recipient, execution_jid, source, delivery_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(
    event.id,
    event.recipient,
    event.executionJid,
    event.source,
    event.deliveryMode,
    event.createdAt,
    event.createdAt,
  );
}

export function getAgentEvent(id: string): AgentEvent | undefined {
  return db.prepare('SELECT * FROM agent_events WHERE id = ?').get(id) as
    | AgentEvent
    | undefined;
}

export function getAgentEvents(ids: string[]): AgentEvent[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM agent_events WHERE id IN (${placeholders})`)
    .all(...ids) as AgentEvent[];
}

export function getCaptureTarget(executionJid: string): string | undefined {
  const row = db
    .prepare(
      `SELECT recipient FROM agent_events
       WHERE execution_jid = ? AND delivery_mode = 'capture'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(executionJid) as { recipient: string } | undefined;
  return row?.recipient;
}

export function markAgentEventsRunning(
  ids: string[],
  executionId: string,
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE agent_events
     SET status = 'running', execution_id = ?, result = NULL, error = NULL, updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(executionId, new Date().toISOString(), ...ids);
}

export function completeAgentEvents(
  ids: string[],
  result: string | null,
): void {
  updateStatus(ids, 'completed', result, null);
}

export function failAgentEvents(ids: string[], error: string): void {
  updateStatus(ids, 'failed', null, error);
}

function updateStatus(
  ids: string[],
  status: AgentEventStatus,
  result: string | null,
  error: string | null,
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE agent_events
     SET status = ?, result = ?, error = ?, updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(status, result, error, new Date().toISOString(), ...ids);
}

export function recoverCaptureAgentEvents(): string[] {
  db.prepare(
    `UPDATE agent_events SET status = 'queued', execution_id = NULL, updated_at = ?
     WHERE delivery_mode = 'capture' AND status = 'running'`,
  ).run(new Date().toISOString());
  return (
    db
      .prepare(
        `SELECT DISTINCT execution_jid FROM agent_events
         WHERE delivery_mode = 'capture' AND status = 'queued'`,
      )
      .all() as Array<{ execution_jid: string }>
  ).map((row) => row.execution_jid);
}

export function pruneAgentEvents(retentionDays: number = 7): number {
  const result = db
    .prepare(
      `DELETE FROM agent_events
       WHERE status IN ('completed', 'failed')
         AND updated_at < datetime('now', ?)`,
    )
    .run(`-${retentionDays} days`);
  return result.changes;
}
