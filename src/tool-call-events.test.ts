/**
 * Tests for host-side tool_call_events queries.
 * Verifies the host can read tool call events from a session's outbound.db.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
} from './db/index.js';
import {
  resolveSession,
  initSessionFolder,
  outboundDbPath,
} from './session-manager.js';
import { countToolCallEvents, getToolCallEvents } from './db/session-db.js';

// Mock container runner
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-tool-events' };
});

const TEST_DIR = '/tmp/nanoclaw-test-tool-events';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('tool_call_events host queries', () => {
  it('reads tool call events from a session outbound.db', () => {
    // Create agent group and session
    createAgentGroup({ id: 'ag-ceo', name: 'CEO', folder: 'ceo', agent_provider: null, created_at: now() });
    const { session } = resolveSession('ag-ceo', null, null, 'agent-shared');
    initSessionFolder('ag-ceo', session.id);

    // Simulate container writing tool_call_events to outbound.db
    const outPath = outboundDbPath('ag-ceo', session.id);
    const outDb = new Database(outPath);
    outDb.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_events (
        id          TEXT PRIMARY KEY,
        tool_name   TEXT NOT NULL,
        tool_input  TEXT,
        started_at  TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER,
        error       TEXT
      );
    `);
    outDb.prepare(
      `INSERT INTO tool_call_events (id, tool_name, tool_input, started_at, finished_at, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('tc-1', 'Read', '{"file_path":"/test.txt"}', now(), now(), 42, null);
    outDb.prepare(
      `INSERT INTO tool_call_events (id, tool_name, tool_input, started_at, finished_at, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('tc-2', 'Bash', '{"command":"ls"}', now(), now(), 100, null);
    outDb.close();

    // Host reads the outbound.db (read-only)
    const hostOutDb = new Database(outPath, { readonly: true });

    // Count
    const count = countToolCallEvents(hostOutDb);
    expect(count).toBe(2);

    // Get all events
    const events = getToolCallEvents(hostOutDb);
    expect(events).toHaveLength(2);
    expect(events[0].tool_name).toBe('Read');
    expect(events[0].duration_ms).toBe(42);
    expect(events[1].tool_name).toBe('Bash');

    // Get limited events (most recent)
    const recent = getToolCallEvents(hostOutDb, 1);
    expect(recent).toHaveLength(1);

    hostOutDb.close();
  });

  it('returns empty array when tool_call_events table does not exist', () => {
    createAgentGroup({ id: 'ag-old', name: 'Old Agent', folder: 'old-agent', agent_provider: null, created_at: now() });
    const { session } = resolveSession('ag-old', null, null, 'agent-shared');
    initSessionFolder('ag-old', session.id);

    // Open outbound.db but do NOT create tool_call_events table
    const outPath = outboundDbPath('ag-old', session.id);
    const hostOutDb = new Database(outPath, { readonly: true });

    // Should gracefully return empty
    const count = countToolCallEvents(hostOutDb);
    expect(count).toBe(0);

    const events = getToolCallEvents(hostOutDb);
    expect(events).toHaveLength(0);

    hostOutDb.close();
  });

  it('correctly reports tool errors', () => {
    createAgentGroup({ id: 'ag-err', name: 'Error Agent', folder: 'error-agent', agent_provider: null, created_at: now() });
    const { session } = resolveSession('ag-err', null, null, 'agent-shared');
    initSessionFolder('ag-err', session.id);

    const outPath = outboundDbPath('ag-err', session.id);
    const outDb = new Database(outPath);
    outDb.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_events (
        id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, tool_input TEXT,
        started_at TEXT NOT NULL, finished_at TEXT NOT NULL, duration_ms INTEGER, error TEXT
      );
    `);
    outDb.prepare(
      `INSERT INTO tool_call_events (id, tool_name, tool_input, started_at, finished_at, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('tc-err', 'Bash', '{"command":"false"}', now(), now(), 5, 'tool_use_failure');
    outDb.close();

    const hostOutDb = new Database(outPath, { readonly: true });
    const events = getToolCallEvents(hostOutDb);
    expect(events).toHaveLength(1);
    expect(events[0].error).toBe('tool_use_failure');
    hostOutDb.close();
  });
});
