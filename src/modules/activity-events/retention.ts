/**
 * Retention sweep — drop activity_events older than the retention window.
 * Single DELETE per call; the (timestamp) coverage in the secondary indexes
 * keeps it cheap. Called from the host sweep loop, throttled by
 * `RETENTION_MIN_INTERVAL_MS` so we don't run a DELETE every 60 seconds
 * for no reason.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';

export const RETENTION_DAYS = 7;
export const RETENTION_WINDOW_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Delete events older than `cutoff` ms epoch. Returns rows deleted. */
export function pruneOlderThan(db: Database.Database, cutoffMs: number): number {
  try {
    const stmt = db.prepare('DELETE FROM activity_events WHERE timestamp < ?');
    const info = stmt.run(cutoffMs);
    return Number(info.changes ?? 0);
  } catch (err) {
    log.error('activity-events retention sweep failed', { err });
    return 0;
  }
}

export function pruneRetention(db: Database.Database, now: number = Date.now()): number {
  return pruneOlderThan(db, now - RETENTION_WINDOW_MS);
}
