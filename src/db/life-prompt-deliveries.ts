import Database from 'better-sqlite3';

export interface LifePromptDeliveryScope {
  endpoint: string;
  journalId: string;
  credentialFingerprint: string;
  destination: string;
}

export interface LifePromptDeliveryReceipt {
  endpoint: string;
  journal_id: string;
  credential_fingerprint: string;
  destination: string;
  prompt_instance_id: string;
  part_index: number;
  part_count: number;
  telegram_message_id: number;
  source_message_key: string;
  acknowledged: number;
  created_at: string;
}

let db: Database.Database;

/** @internal */
export function _setLifePromptDeliveriesDb(database: Database.Database): void {
  db = database;
}

function requireDb(): Database.Database {
  if (!db) {
    throw new Error('life_prompt_deliveries database not initialized');
  }
  return db;
}

export function insertLifePromptDeliveryReceipt(input: {
  scope: LifePromptDeliveryScope;
  promptInstanceId: string;
  partIndex: number;
  partCount: number;
  telegramMessageId: number;
  sourceMessageKey: string;
}): void {
  requireDb()
    .prepare(
      `INSERT OR REPLACE INTO life_prompt_deliveries
        (endpoint, journal_id, credential_fingerprint, destination, prompt_instance_id, part_index, part_count, telegram_message_id, source_message_key, acknowledged, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT acknowledged FROM life_prompt_deliveries WHERE endpoint = ? AND journal_id = ? AND credential_fingerprint = ? AND destination = ? AND prompt_instance_id = ? AND part_index = ?), 0), ?)`,
    )
    .run(
      input.scope.endpoint,
      input.scope.journalId,
      input.scope.credentialFingerprint,
      input.scope.destination,
      input.promptInstanceId,
      input.partIndex,
      input.partCount,
      input.telegramMessageId,
      input.sourceMessageKey,
      input.scope.endpoint,
      input.scope.journalId,
      input.scope.credentialFingerprint,
      input.scope.destination,
      input.promptInstanceId,
      input.partIndex,
      new Date().toISOString(),
    );
}

export function getLifePromptDeliveryReceipts(
  scope: LifePromptDeliveryScope,
  promptInstanceId: string,
): LifePromptDeliveryReceipt[] {
  return requireDb()
    .prepare(
      `SELECT * FROM life_prompt_deliveries
        WHERE endpoint = ? AND journal_id = ? AND credential_fingerprint = ? AND destination = ? AND prompt_instance_id = ?
        ORDER BY part_index ASC`,
    )
    .all(
      scope.endpoint,
      scope.journalId,
      scope.credentialFingerprint,
      scope.destination,
      promptInstanceId,
    ) as LifePromptDeliveryReceipt[];
}

export function listLifePromptDeliveryPromptIds(
  scope: LifePromptDeliveryScope,
): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT DISTINCT prompt_instance_id AS promptInstanceId FROM life_prompt_deliveries
        WHERE endpoint = ? AND journal_id = ? AND credential_fingerprint = ? AND destination = ?`,
    )
    .all(
      scope.endpoint,
      scope.journalId,
      scope.credentialFingerprint,
      scope.destination,
    ) as Array<{ promptInstanceId: string }>;
  return rows.map((row) => row.promptInstanceId);
}

export function listUnacknowledgedLifePromptIds(
  scope: LifePromptDeliveryScope,
): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT DISTINCT prompt_instance_id AS promptInstanceId FROM life_prompt_deliveries
        WHERE endpoint = ? AND journal_id = ? AND credential_fingerprint = ? AND destination = ? AND acknowledged = 0`,
    )
    .all(
      scope.endpoint,
      scope.journalId,
      scope.credentialFingerprint,
      scope.destination,
    ) as Array<{ promptInstanceId: string }>;
  return rows.map((row) => row.promptInstanceId);
}

export function markLifePromptDeliveryAcknowledged(
  scope: LifePromptDeliveryScope,
  promptInstanceId: string,
): void {
  requireDb()
    .prepare(
      `UPDATE life_prompt_deliveries SET acknowledged = 1
        WHERE endpoint = ? AND journal_id = ? AND credential_fingerprint = ? AND destination = ? AND prompt_instance_id = ?`,
    )
    .run(
      scope.endpoint,
      scope.journalId,
      scope.credentialFingerprint,
      scope.destination,
      promptInstanceId,
    );
}

export function isLifePromptDeliveryAcknowledged(
  scope: LifePromptDeliveryScope,
  promptInstanceId: string,
): boolean {
  const rows = getLifePromptDeliveryReceipts(scope, promptInstanceId);
  return (
    rows.length > 0 && rows.every((row) => row.acknowledged === 1)
  );
}

export function updateLifePromptDeliverySourceKey(
  scope: LifePromptDeliveryScope,
  promptInstanceId: string,
  sourceMessageKey: string,
): void {
  requireDb()
    .prepare(
      `UPDATE life_prompt_deliveries SET source_message_key = ?
        WHERE endpoint = ? AND journal_id = ? AND credential_fingerprint = ? AND destination = ? AND prompt_instance_id = ?`,
    )
    .run(
      sourceMessageKey,
      scope.endpoint,
      scope.journalId,
      scope.credentialFingerprint,
      scope.destination,
      promptInstanceId,
    );
}
