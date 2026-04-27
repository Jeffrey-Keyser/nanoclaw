import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migration014 } from '../../db/migrations/014-activity-events.js';
import { ActivityEventLogger } from './logger.js';
import { pruneRetention, RETENTION_WINDOW_MS } from './retention.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migration014.up(db);
});

afterEach(() => {
  db.close();
});

describe('pruneRetention', () => {
  it('deletes events older than the retention window and keeps fresh ones', () => {
    const logger = new ActivityEventLogger(db);
    const now = Date.now();

    logger.recordDecision('s1', 'ceo', { age: 'old' }, now - RETENTION_WINDOW_MS - 60_000);
    logger.recordDecision('s1', 'ceo', { age: 'fresh' }, now - 60_000);

    const removed = pruneRetention(db, now);
    expect(removed).toBe(1);

    const survivors = logger.queryRecent('ceo', RETENTION_WINDOW_MS / 60_000 + 100, 50);
    expect(survivors).toHaveLength(1);
    const parsed = JSON.parse(survivors[0]!.payload);
    expect(parsed.age).toBe('fresh');
  });

  it('is a no-op when nothing is past the cutoff', () => {
    const logger = new ActivityEventLogger(db);
    logger.recordDecision('s1', 'ceo', {}, Date.now());
    const removed = pruneRetention(db, Date.now());
    expect(removed).toBe(0);
  });
});
