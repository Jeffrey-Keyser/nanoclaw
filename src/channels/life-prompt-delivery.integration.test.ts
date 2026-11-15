import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from '../db/index.js';
import {
  getLifePromptDeliveryReceipts,
  isLifePromptDeliveryAcknowledged,
  type LifePromptDeliveryScope,
} from '../db/life-prompt-deliveries.js';
import {
  credentialFingerprint,
  LifePromptDeliveryConsumer,
  type PromptBotAdapter,
} from './life-prompt-delivery.js';

const SECRET_TOKEN = 'secret-token-xyz-987';
const BASE_URL = 'https://life.example.com';
const JOURNAL_ID = 'journal-1';

function scope(): LifePromptDeliveryScope {
  return {
    endpoint: BASE_URL,
    journalId: JOURNAL_ID,
    credentialFingerprint: credentialFingerprint(SECRET_TOKEN),
    destination: 'tg:111',
  };
}

function groups() {
  return {
    'tg:111': {
      name: 'CEO',
      folder: 'ceo',
      trigger: '^@Andy\\b',
      added_at: new Date().toISOString(),
    },
  } as unknown as Record<string, import('../types.js').RegisteredGroup>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('life-prompt-delivery integration', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('traverses connection retrieval send persistence failed ack restart and replay', async () => {
    const promptText = 'integration-retained-prompt-text';
    const sent: Array<{ chatId: string; text: string }> = [];
    let nextId = 900;
    const bot: PromptBotAdapter = {
      getChatType: vi.fn(async () => 'private'),
      sendText: vi.fn(async (chatId: string, text: string) => {
        sent.push({ chatId, text });
        nextId += 1;
        return nextId;
      }),
    };

    let ackAttempts = 0;
    const outboxItem = {
      promptInstanceId: 'prompt-integration-1',
      kind: 'morning',
      promptText,
    };
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes('/telegram-outbox')) {
          return jsonResponse(
            { success: true, data: { deliveries: [outboxItem] } },
            200,
          );
        }
        if (url.includes('/telegram-delivery')) {
          ackAttempts += 1;
          if (ackAttempts === 1) {
            return jsonResponse({ success: false }, 500);
          }
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(typeof body['sourceMessageKey']).toBe('string');
          return jsonResponse(
            {
              success: true,
              data: { promptInstanceId: 'prompt-integration-1' },
            },
            200,
          );
        }
        throw new Error(`unexpected url ${url}`);
      },
    );

    const first = new LifePromptDeliveryConsumer({
      configProvider: () => ({
        baseUrl: BASE_URL,
        journalId: JOURNAL_ID,
        token: SECRET_TOKEN,
      }),
      groupsProvider: () => groups(),
      botProvider: () => bot,
      fetchImpl,
    });
    first.start();
    expect(first.isRunning()).toBe(true);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe('111');
    expect(sent[0].text).toBe(`Morning check-in\n\n${promptText}`);

    const receipts = getLifePromptDeliveryReceipts(
      scope(),
      'prompt-integration-1',
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].telegram_message_id).toBeGreaterThan(900);
    expect(isLifePromptDeliveryAcknowledged(scope(), 'prompt-integration-1')).toBe(false);

    first.stop();
    expect(first.isRunning()).toBe(false);

    const restarted = new LifePromptDeliveryConsumer({
      configProvider: () => ({
        baseUrl: BASE_URL,
        journalId: JOURNAL_ID,
        token: SECRET_TOKEN,
      }),
      groupsProvider: () => groups(),
      botProvider: () => bot,
      fetchImpl,
    });
    restarted.start();
    await vi.waitFor(() => {
      expect(ackAttempts).toBe(2);
    });
    restarted.stop();

    expect(sent).toHaveLength(1);
    expect(ackAttempts).toBe(2);
    expect(
      isLifePromptDeliveryAcknowledged(scope(), 'prompt-integration-1'),
    ).toBe(true);
  });
});
