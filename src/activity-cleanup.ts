/**
 * Periodic 7-day retention sweep for activity events.
 *
 * Only runs when the container for a session is NOT running, so we don't
 * fight the container for the outbound.db write lock (single-writer-per-file
 * is load-bearing on the cross-mount sqlite — see src/session-manager.ts).
 *
 * Wired into host-sweep.ts; the sweep tick already iterates active sessions.
 */
import fs from 'fs';

import { deleteOldToolCallEvents } from './db/session-db.js';
import { openOutboundDbWritable } from './db/session-db.js';
import { log } from './log.js';
import { outboundDbPath } from './session-manager.js';

const RETENTION_DAYS = 7;

/**
 * Compute the ISO cutoff for retention. Pure for unit testing.
 */
export function retentionCutoffIso(now: Date = new Date(), days: number = RETENTION_DAYS): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * Run the retention sweep against one session's outbound.db. The caller
 * is responsible for ensuring the container is NOT running. Logs the row
 * count when something is actually deleted; silent on a no-op.
 */
export function runRetentionForSession(agentGroupId: string, sessionId: string, now: Date = new Date()): void {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  let db;
  try {
    db = openOutboundDbWritable(dbPath);
  } catch (err) {
    log.warn('Activity retention: could not open outbound.db', { sessionId, err });
    return;
  }

  try {
    const cutoff = retentionCutoffIso(now);
    const deleted = deleteOldToolCallEvents(db, cutoff);
    if (deleted > 0) {
      log.info('Activity retention: deleted old events', { sessionId, deleted, cutoff });
    }
  } catch (err) {
    log.warn('Activity retention: delete failed', { sessionId, err });
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
}
