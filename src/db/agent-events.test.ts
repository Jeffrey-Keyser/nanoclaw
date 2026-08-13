import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, _setMigrationsDir } from './index.js';
import {
  completeAgentEvents,
  getAgentEvent,
  insertAgentEvent,
  markAgentEventsRunning,
  recoverCaptureAgentEvents,
} from './agent-events.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

describe('agent event persistence', () => {
  beforeEach(() => {
    _setMigrationsDir(MIGRATIONS_DIR);
    _initTestDatabase();
  });

  it('tracks a captured event through execution and completion', () => {
    insertAgentEvent({
      id: 'event-1',
      recipient: 'tg:123',
      executionJid: 'agent-event-capture:tg:123',
      source: 'test',
      deliveryMode: 'capture',
      createdAt: '2026-08-13T00:00:00.000Z',
    });

    markAgentEventsRunning(['event-1'], 'runner-a');
    completeAgentEvents(['event-1'], 'CANARY_OK');

    expect(getAgentEvent('event-1')).toMatchObject({
      status: 'completed',
      execution_id: 'runner-a',
      result: 'CANARY_OK',
      delivery_mode: 'capture',
    });
  });

  it('recovers interrupted capture executions as queued work', () => {
    insertAgentEvent({
      id: 'event-1',
      recipient: 'tg:123',
      executionJid: 'agent-event-capture:tg:123',
      source: 'test',
      deliveryMode: 'capture',
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    markAgentEventsRunning(['event-1'], 'runner-a');

    expect(recoverCaptureAgentEvents()).toEqual(['agent-event-capture:tg:123']);
    expect(getAgentEvent('event-1')).toMatchObject({
      status: 'queued',
      execution_id: null,
    });
  });
});
