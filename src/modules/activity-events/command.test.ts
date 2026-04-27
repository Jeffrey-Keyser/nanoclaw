/**
 * End-to-end test of /activity through the command gate.
 *
 * Boots an in-memory central DB, runs migrations, plants a fixture
 * sequence of activity_events, then drives the actual gateCommand path
 * and asserts the rendered output: chronological order, line-per-event,
 * 50-event cap respected, truncation note when applicable, malformed
 * args produce the usage message.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { gateCommand, parseActivityArgs } from '../../command-gate.js';
import { ActivityEventLogger } from './logger.js';

const AGENT_ID = 'ag-1';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  // Insert a minimal agent_group row so the fallback name resolves.
  // No user_roles row is planted: the gate's `hasTable` check trips the
  // table-present path, and with `userId: null` the deny branch is hit
  // for non-admin commands — so we pass a real userId for the test.
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(AGENT_ID, 'ceo', 'ceo-folder', null);
  db.prepare(
    `INSERT INTO users (id, kind, display_name, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run('telegram:1', 'telegram', 'admin');
  db.prepare(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
     VALUES (?, 'owner', NULL, NULL, datetime('now'))`,
  ).run('telegram:1');
});

afterEach(() => {
  closeDb();
});

function jsonContent(text: string): string {
  return JSON.stringify({ text });
}

describe('parseActivityArgs', () => {
  it('defaults to fallback agent and 30 minutes when no args', () => {
    expect(parseActivityArgs([], 'ceo')).toEqual({ agent: 'ceo', sinceMinutes: 30 });
  });

  it('treats a single integer as minutes (agent stays fallback)', () => {
    expect(parseActivityArgs(['15'], 'ops')).toEqual({ agent: 'ops', sinceMinutes: 15 });
  });

  it('treats a single non-integer as agent', () => {
    expect(parseActivityArgs(['ceo'], 'ops')).toEqual({ agent: 'ceo', sinceMinutes: 30 });
  });

  it('parses agent + minutes', () => {
    expect(parseActivityArgs(['ops', '60'], 'ceo')).toEqual({ agent: 'ops', sinceMinutes: 60 });
  });

  it('rejects non-numeric minutes', () => {
    expect(parseActivityArgs(['ceo', 'forever'], 'ceo')).toBeNull();
  });

  it('rejects negative or zero minutes', () => {
    expect(parseActivityArgs(['ceo', '0'], 'ceo')).toBeNull();
    expect(parseActivityArgs(['-5'], 'ceo')).toBeNull();
  });

  it('rejects too many args', () => {
    expect(parseActivityArgs(['ceo', '5', 'extra'], 'ceo')).toBeNull();
  });
});

describe('/activity command end-to-end', () => {
  const ADMIN = 'telegram:1';

  it('renders a chronological text stream with one line per event', () => {
    const logger = new ActivityEventLogger(getDb());
    const t0 = Date.now();
    logger.recordToolCallStart('s1', 'ceo', 'Bash', { args: { command: 'ls' } }, t0);
    logger.recordToolCallComplete('s1', 'ceo', 'Bash', { duration_ms: 5 }, t0 + 5);
    logger.recordDecision('s1', 'ceo', { summary: 'chose endpoint X' }, t0 + 10);

    const result = gateCommand(jsonContent('/activity'), ADMIN, AGENT_ID);
    expect(result.action).toBe('respond');
    if (result.action !== 'respond') return;

    expect(result.text).toContain('Bash');
    expect(result.text).toContain('chose endpoint X');
    expect(result.text).not.toContain('older events truncated');
    const dataLines = result.text.split('\n').filter((l) => /^\d{2}:\d{2}:\d{2}/.test(l));
    expect(dataLines.length).toBe(3);
  });

  it('respects the 50-event cap and shows a truncation note', () => {
    const logger = new ActivityEventLogger(getDb());
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      logger.recordToolCallStart('s1', 'ceo', `T${i}`, {}, t0 + i);
    }

    const result = gateCommand(jsonContent('/activity'), ADMIN, AGENT_ID);
    expect(result.action).toBe('respond');
    if (result.action !== 'respond') return;

    const dataLines = result.text.split('\n').filter((l) => /^\d{2}:\d{2}:\d{2}/.test(l));
    expect(dataLines.length).toBe(50);
    expect(result.text).toContain('older events truncated');
  });

  it('rejects malformed args with the usage message', () => {
    const result = gateCommand(jsonContent('/activity ceo notaminute'), ADMIN, AGENT_ID);
    expect(result.action).toBe('respond');
    if (result.action !== 'respond') return;
    expect(result.text).toMatch(/^Usage: \/activity/);
  });

  it('all sentinel queries across agents', () => {
    const logger = new ActivityEventLogger(getDb());
    const t0 = Date.now();
    logger.recordDecision('s1', 'ceo', { summary: 'ceo decision' }, t0);
    logger.recordDecision('s2', 'ops', { summary: 'ops decision' }, t0 + 1);

    const result = gateCommand(jsonContent('/activity all'), ADMIN, AGENT_ID);
    expect(result.action).toBe('respond');
    if (result.action !== 'respond') return;
    expect(result.text).toContain('ceo decision');
    expect(result.text).toContain('ops decision');
  });

  it('denies non-admin users', () => {
    const result = gateCommand(jsonContent('/activity'), 'telegram:99', AGENT_ID);
    expect(result.action).toBe('deny');
  });
});
