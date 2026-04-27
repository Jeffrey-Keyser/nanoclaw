/**
 * Public surface of the activity-events module.
 *
 * Host code (router, sweep, command-gate) imports the bits it needs from
 * this barrel. Tests import the underlying files directly so test-only
 * helpers don't pollute the public surface.
 */
export { ActivityEventLogger, PAYLOAD_MAX_BYTES } from './logger.js';
export type { ActivityAgent, ActivityEventRow, ActivityEventType } from './logger.js';
export { redactSecrets } from './redact.js';
export { renderActivityStream, ACTIVITY_OUTPUT_CAP, ACTIVITY_USAGE } from './render.js';
export { pruneRetention, pruneOlderThan, RETENTION_DAYS, RETENTION_WINDOW_MS } from './retention.js';
export { mirrorSessionToolCalls } from './sync.js';
export {
  AutoStreamPublisher,
  PER_AGENT_THROTTLE_MS,
  getOperatorChat,
  isAutoStreamEnabled,
  isMajorEvent,
  parseOperatorChat,
  publishEventIfMajor,
} from './auto-stream.js';
export type { OperatorChatTarget } from './auto-stream.js';

import type Database from 'better-sqlite3';
import { ActivityEventLogger } from './logger.js';
import { getDb } from '../../db/connection.js';

let _shared: ActivityEventLogger | null = null;

/**
 * Convenience accessor for callers that need a logger bound to the
 * already-initialized central DB. Cached on first call. Falls back to
 * creating a fresh logger if `getDb()` returns a different handle (test
 * harness reset).
 */
export function getActivityLogger(db?: Database.Database): ActivityEventLogger {
  const handle = db ?? getDb();
  if (!_shared || (_shared as unknown as { db: Database.Database }).db !== handle) {
    _shared = new ActivityEventLogger(handle);
  }
  return _shared;
}

/** Test helper — clears the cached singleton so a fresh in-memory DB is used. */
export function _resetActivityLogger(): void {
  _shared = null;
}
