import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from '../db/index.js';
import {
  getLifePromptDeliveryReceipts,
  insertLifePromptDeliveryReceipt,
  isLifePromptDeliveryAcknowledged,
  type LifePromptDeliveryScope,
} from '../db/life-prompt-deliveries.js';
import {
  buildPromptParts,
  buildPromptText,
  buildSourceMessageKey,
  ceoDestinationNumeric,
  credentialFingerprint,
  kindLabelFor,
  LifePromptDeliveryConsumer,
  resolveCeoDestination,
  splitTelegramParts,
  TELEGRAM_PROMPT_MAX_LENGTH,
  type LifePromptDeliveryConfig,
  type PromptBotAdapter,
} from './life-prompt-delivery.js';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const SECRET_TOKEN = 'secret-token-xyz-987';
const SECRET_TEXT = 'secret-prompt-text-abc-123-unique';
const BASE_URL = 'https://life.example.com';
const JOURNAL_ID = 'journal-1';

function config(overrides: Partial<LifePromptDeliveryConfig> = {}): LifePromptDeliveryConfig {
  return {
    baseUrl: BASE_URL,
    journalId: JOURNAL_ID,
    token: SECRET_TOKEN,
    ...overrides,
  };
}

function groupsFor(chatId: string) {
  return {
    [`tg:${chatId}`]: {
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

function outboxBody(
  deliveries: Array<{ promptInstanceId: string; kind: string; promptText: string }>,
): Record<string, unknown> {
  return {
    success: true,
    data: {
      deliveries: deliveries.map((d) => ({
        promptInstanceId: d.promptInstanceId,
        kind: d.kind,
        promptText: d.promptText,
      })),
    },
  };
}

interface BotHarness {
  adapter: PromptBotAdapter;
  sent: Array<{ chatId: string; text: string }>;
  chatType: string;
  failOnCall?: number;
  nextId: number;
}

function makeBot(chatType = 'private'): BotHarness {
  const harness: BotHarness = {
    adapter: null as unknown as PromptBotAdapter,
    sent: [],
    chatType,
    nextId: 500,
  };
  harness.adapter = {
    getChatType: vi.fn(async () => harness.chatType),
    sendText: vi.fn(async (chatId: string, text: string) => {
      harness.sent.push({ chatId, text });
      if (
        typeof harness.failOnCall === 'number' &&
        harness.sent.length === harness.failOnCall
      ) {
        throw new Error('telegram down');
      }
      harness.nextId += 1;
      return harness.nextId;
    }),
  };
  return harness;
}

function makeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return { fetchImpl, calls };
}

function loggedText(): string {
  const mocked = logger as unknown as {
    info: { mock: { calls: unknown[][] } };
    warn: { mock: { calls: unknown[][] } };
    error: { mock: { calls: unknown[][] } };
    debug: { mock: { calls: unknown[][] } };
  };
  return JSON.stringify([
    ...mocked.info.mock.calls,
    ...mocked.warn.mock.calls,
    ...mocked.error.mock.calls,
    ...mocked.debug.mock.calls,
  ]);
}

describe('life-prompt-delivery', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runOnce(consumer: LifePromptDeliveryConsumer): Promise<void> {
    (consumer as unknown as { stopped: boolean }).stopped = false;
    await consumer.pollOnce();
    consumer.stop();
  }

  it('resolves exactly one positive ceo destination', () => {
    expect(resolveCeoDestination(groupsFor('111'))).toBe('tg:111');
    expect(resolveCeoDestination({})).toBeNull();
    const two = { ...groupsFor('111'), ...groupsFor('222') };
    expect(resolveCeoDestination(two)).toBeNull();
    expect(resolveCeoDestination({ 'tg:0': { folder: 'ceo' } as never })).toBeNull();
    expect(
      resolveCeoDestination({ 'tg:abc': { folder: 'ceo' } as never }),
    ).toBeNull();
    expect(
      resolveCeoDestination({ 'tg:111': { folder: 'ops' } as never }),
    ).toBeNull();
    expect(ceoDestinationNumeric('tg:111')).toBe('111');
  });

  it('labels known kinds and falls back to Conversation starter', () => {
    expect(kindLabelFor('morning')).toBe('Morning check-in');
    expect(kindLabelFor('EVENING')).toBe('Evening reflection');
    expect(kindLabelFor('check_in')).toBe('Check-in');
    expect(kindLabelFor('some-future-kind')).toBe('Conversation starter');
    expect(kindLabelFor('')).toBe('Conversation starter');
  });

  it('splits deterministically at the Telegram length limit', () => {
    expect(splitTelegramParts('a'.repeat(TELEGRAM_PROMPT_MAX_LENGTH))).toHaveLength(1);
    const long = 'b'.repeat(TELEGRAM_PROMPT_MAX_LENGTH + 10);
    const parts = splitTelegramParts(long);
    expect(parts).toHaveLength(2);
    expect(parts.join('')).toBe(long);
    expect(parts[0]).toHaveLength(TELEGRAM_PROMPT_MAX_LENGTH);
    expect(splitTelegramParts(long)).toEqual(parts);
  });

  it('builds a printable source key within the length limit', () => {
    const key = buildSourceMessageKey('111', [501, 502]);
    expect(key).toBe('telegram:111:501.502');
    const big = buildSourceMessageKey('111', Array.from({ length: 500 }, (_, i) => 100000 + i));
    expect(big.length).toBeLessThanOrEqual(256);
    expect(big.startsWith('telegram:111:')).toBe(true);
  });

  it('sends nothing when configuration is missing', async () => {
    const bot = makeBot();
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(outboxBody([]), 200));
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => null,
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);
    expect(calls).toHaveLength(0);
    expect(bot.sent).toHaveLength(0);
  });

  it('sends nothing when routing is missing or ambiguous', async () => {
    for (const groups of [{}, { ...groupsFor('111'), ...groupsFor('222') }]) {
      const bot = makeBot();
      const { fetchImpl, calls } = makeFetch(() => jsonResponse(outboxBody([]), 200));
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groups as never,
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      await runOnce(consumer);
      expect(calls).toHaveLength(0);
      expect(bot.sent).toHaveLength(0);
    }
  });

  it('sends nothing for non-private destinations or verification failures', async () => {
    for (const chatType of ['group', 'supergroup', 'channel']) {
      const bot = makeBot(chatType);
      const { fetchImpl, calls } = makeFetch(() => jsonResponse(outboxBody([]), 200));
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groupsFor('111'),
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      consumer.start();
      await consumer.pollOnce();
      consumer.stop();
      expect(calls).toHaveLength(0);
      expect(bot.sent).toHaveLength(0);
    }

    const failingBot: PromptBotAdapter = {
      getChatType: vi.fn(async () => {
        throw new Error('down');
      }),
      sendText: vi.fn(async () => 1),
    };
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(outboxBody([]), 200));
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => failingBot,
      fetchImpl,
    });
    await runOnce(consumer);
    expect(calls).toHaveLength(0);
  });

  it('delivers eligible prompts with exact text and kind labels', async () => {
    const bot = makeBot();
    const ackCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { fetchImpl } = makeFetch((url, init) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(
          outboxBody([{ promptInstanceId: 'p-1', kind: 'morning', promptText: SECRET_TEXT }]),
          200,
        );
      }
      ackCalls.push({ url, init });
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-1' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);

    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].chatId).toBe('111');
    expect(bot.sent[0].text).toBe(`Morning check-in\n\n${SECRET_TEXT}`);
    expect(bot.sent[0].text).toContain(SECRET_TEXT);
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0].url).toContain('/prompt-instances/p-1/telegram-delivery');
    const ackBody = JSON.parse(String(ackCalls[0].init?.body)) as Record<string, unknown>;
    expect(typeof ackBody['sourceMessageKey']).toBe('string');
    expect(String(ackBody['sourceMessageKey']).length).toBeLessThanOrEqual(256);

    const scope: LifePromptDeliveryScope = {
      endpoint: BASE_URL,
      journalId: JOURNAL_ID,
      credentialFingerprint: (
        await import('crypto')
      ).createHash('sha256').update(SECRET_TOKEN, 'utf8').digest('hex'),
      destination: 'tg:111',
    };
    expect(isLifePromptDeliveryAcknowledged(scope, 'p-1')).toBe(true);
  });

  it('uses Conversation starter for unknown historical kinds', async () => {
    const bot = makeBot();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(
          outboxBody([{ promptInstanceId: 'p-x', kind: 'vintage-2060', promptText: 'hello' }]),
          200,
        );
      }
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-x' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].text.startsWith('Conversation starter\n\n')).toBe(true);
    expect(bot.sent[0].text.endsWith('hello')).toBe(true);
  });

  it('sends nothing for empty unsuccessful or malformed reads', async () => {
    const bodies: Array<{ body: unknown; status: number } | { fail: true }> = [
      { body: { success: true, data: { deliveries: [] } }, status: 200 },
      { body: { success: false, data: { deliveries: [] } }, status: 200 },
      { body: { ok: true }, status: 200 },
      { body: { success: true, data: null }, status: 200 },
      { body: { success: true, data: { deliveries: [{ kind: 'morning' }] } }, status: 200 },
      { body: { success: true, data: { deliveries: [] } }, status: 500 },
    ];
    for (const entry of bodies) {
      const bot = makeBot();
      const { fetchImpl } = makeFetch((url) => {
        if (url.includes('/telegram-outbox')) {
          if ('fail' in entry) throw new Error('down');
          return jsonResponse(entry.body, entry.status);
        }
        return jsonResponse({ success: true, data: {} }, 200);
      });
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groupsFor('111'),
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      consumer.start();
      await consumer.pollOnce();
      consumer.stop();
      expect(bot.sent).toHaveLength(0);
    }
  });

  it('delivers multipart prompts and acknowledges once with a stable key', async () => {
    const big = `x `.repeat(3000).trim();
    const bot = makeBot();
    const ackBodies: string[] = [];
    const { fetchImpl } = makeFetch((url, init) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(
          outboxBody([{ promptInstanceId: 'p-big', kind: 'evening', promptText: big }]),
          200,
        );
      }
      ackBodies.push(String(init?.body));
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-big' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);

    expect(bot.sent.length).toBeGreaterThan(1);
    for (const part of bot.sent) {
      expect(part.text.length).toBeLessThanOrEqual(TELEGRAM_PROMPT_MAX_LENGTH);
    }
    expect(bot.sent.map((s) => s.text).join('')).toBe(`Evening reflection\n\n${big}`);
    expect(ackBodies).toHaveLength(1);
    const key = (JSON.parse(ackBodies[0]) as Record<string, unknown>)['sourceMessageKey'];
    expect(typeof key).toBe('string');
  });

  it('pauses remaining parts when eligibility disappears', async () => {
    const big = 'z'.repeat(TELEGRAM_PROMPT_MAX_LENGTH + 50);
    const bot = makeBot();
    let outboxCalls = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/telegram-outbox')) {
        outboxCalls += 1;
        if (outboxCalls === 1) {
          return jsonResponse(
            outboxBody([{ promptInstanceId: 'p-w', kind: 'nudge', promptText: big }]),
            200,
          );
        }
        return jsonResponse(outboxBody([]), 200);
      }
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-w' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);

    expect(bot.sent).toHaveLength(1);
    expect(outboxCalls).toBeGreaterThanOrEqual(2);
  });

  it('never acknowledges failed sends', async () => {
    const bot = makeBot();
    bot.failOnCall = 1;
    let ackCalls = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(
          outboxBody([{ promptInstanceId: 'p-f', kind: 'morning', promptText: 'hi' }]),
          200,
        );
      }
      ackCalls += 1;
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-f' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);
    expect(bot.sent).toHaveLength(1);
    expect(ackCalls).toBe(0);
  });

  it('retains receipts on acknowledgment failure conflict and mismatch', async () => {
    const modes: Array<{ status: number; body: unknown }> = [
      { status: 500, body: { success: false } },
      { status: 409, body: { success: false, data: {} } },
      { status: 200, body: { success: true, data: { promptInstanceId: 'other' } } },
      { status: 200, body: { success: true, data: null } },
    ];
    for (const mode of modes) {
      _initTestDatabase();
      const bot = makeBot();
      const { fetchImpl } = makeFetch((url) => {
        if (url.includes('/telegram-outbox')) {
          return jsonResponse(
            outboxBody([{ promptInstanceId: 'p-a', kind: 'morning', promptText: 'hi' }]),
            200,
          );
        }
        return jsonResponse(mode.body, mode.status);
      });
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groupsFor('111'),
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      await runOnce(consumer);
      expect(bot.sent).toHaveLength(1);
      const { credentialFingerprint } = await import('./life-prompt-delivery.js');
      const scope: LifePromptDeliveryScope = {
        endpoint: BASE_URL,
        journalId: JOURNAL_ID,
        credentialFingerprint: credentialFingerprint(SECRET_TOKEN),
        destination: 'tg:111',
      };
      expect(isLifePromptDeliveryAcknowledged(scope, 'p-a')).toBe(false);
      expect(getLifePromptDeliveryReceipts(scope, 'p-a')).toHaveLength(1);
    }
  });

  it('replays acknowledgment after restart without repeating sends including suppressed eligibility', async () => {
    const { credentialFingerprint } = await import('./life-prompt-delivery.js');
    const scope: LifePromptDeliveryScope = {
      endpoint: BASE_URL,
      journalId: JOURNAL_ID,
      credentialFingerprint: credentialFingerprint(SECRET_TOKEN),
      destination: 'tg:111',
    };
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'p-r',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 777,
      sourceMessageKey: 'telegram:111:777',
    });

    const bot = makeBot();
    const ackBodies: string[] = [];
    const { fetchImpl } = makeFetch((url, init) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(outboxBody([]), 200);
      }
      ackBodies.push(String(init?.body));
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-r' } }, 200);
    });
    const restarted = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(restarted);

    expect(bot.sent).toHaveLength(0);
    expect(ackBodies).toHaveLength(1);
    expect(isLifePromptDeliveryAcknowledged(scope, 'p-r')).toBe(true);
  });

  it('does not send or acknowledge another scope after configuration changes', async () => {
    const { credentialFingerprint } = await import('./life-prompt-delivery.js');
    const scopeA: LifePromptDeliveryScope = {
      endpoint: BASE_URL,
      journalId: JOURNAL_ID,
      credentialFingerprint: credentialFingerprint('token-a'),
      destination: 'tg:111',
    };
    insertLifePromptDeliveryReceipt({
      scope: scopeA,
      promptInstanceId: 'p-a',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 111,
      sourceMessageKey: 'telegram:111:111',
    });

    const bot = makeBot();
    let ackCalls = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(outboxBody([]), 200);
      }
      ackCalls += 1;
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-a' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config({ token: 'token-b' }),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);

    expect(bot.sent).toHaveLength(0);
    expect(ackCalls).toBe(0);
    expect(isLifePromptDeliveryAcknowledged(scopeA, 'p-a')).toBe(false);
  });

  it('aborts when routing changes before sends', async () => {
    const bot = makeBot();
    let groupCalls = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(
          outboxBody([{ promptInstanceId: 'p-c', kind: 'morning', promptText: 'hi' }]),
          200,
        );
      }
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-c' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => {
        groupCalls += 1;
        if (groupCalls <= 1) return groupsFor('111');
        return groupsFor('222');
      },
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);
    expect(bot.sent).toHaveLength(0);
  });

  it('cancellation stops polling and prevents subsequent sends', async () => {
    const bot = makeBot();
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(
          outboxBody([{ promptInstanceId: 'p-s', kind: 'morning', promptText: 'hi' }]),
          200,
        );
      }
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-s' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    consumer.start();
    consumer.stop();
    expect(consumer.isRunning()).toBe(false);
    await consumer.pollOnce();
    expect(calls).toHaveLength(0);
    expect(bot.sent).toHaveLength(0);
  });

  it('serializes concurrent ticks', async () => {
    const bot = makeBot();
    let outboxCalls = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/telegram-outbox')) {
        outboxCalls += 1;
        return jsonResponse(outboxBody([]), 200);
      }
      return jsonResponse({ success: true, data: {} }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    (consumer as unknown as { stopped: boolean }).stopped = false;
    await Promise.all([consumer.pollOnce(), consumer.pollOnce()]);
    consumer.stop();
    expect(outboxCalls).toBeLessThanOrEqual(2);
  });

  it('omits tokens prompt text and unsafe transport errors from logs', async () => {
    const bot = makeBot();
    const { fetchImpl } = makeFetch(() => {
      throw new Error(`transport boom ${SECRET_TOKEN} ${SECRET_TEXT}`);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);
    const text = loggedText();
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SECRET_TEXT);
  });

  it('sends canonical Life prompts with distinct kind labels and preserves compatibility', async () => {
    const cases: Array<{ kind: string; label: string }> = [
      { kind: 'reflective_question', label: 'Reflective question' },
      { kind: 'ai_follow_up', label: 'AI follow-up' },
      { kind: 'archive_gap', label: 'Archive gap' },
      { kind: 'recording_gap', label: 'Recording gap' },
      { kind: 'recent_entry_follow_up', label: 'Recent follow-up' },
      { kind: 'life_event', label: 'Life event' },
    ];
    for (const { kind, label } of cases) {
      _initTestDatabase();
      const question = `canonical-question-for-${kind}`;
      const bot = makeBot();
      const ackBodies: string[] = [];
      const useLegacyId = kind === 'life_event';
      const outboxRecord: Record<string, unknown> = useLegacyId
        ? { id: `p-${kind}`, prompt: question, kind }
        : { promptInstanceId: `p-${kind}`, prompt: question, kind };
      const { fetchImpl } = makeFetch((url, init) => {
        if (url.includes('/telegram-outbox')) {
          return jsonResponse({ success: true, data: { deliveries: [outboxRecord] } }, 200);
        }
        ackBodies.push(String(init?.body));
        return jsonResponse({ success: true, data: { promptInstanceId: `p-${kind}` } }, 200);
      });
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groupsFor('111'),
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      await runOnce(consumer);
      expect(bot.sent).toHaveLength(1);
      expect(bot.sent[0].text).toBe(`${label}\n\n${question}`);
      expect(ackBodies).toHaveLength(1);
    }

    _initTestDatabase();
    {
      const bot = makeBot();
      const { fetchImpl } = makeFetch((url) => {
        if (url.includes('/telegram-outbox')) {
          return jsonResponse(
            {
              success: true,
              data: {
                deliveries: [
                  { promptInstanceId: 'p-sched', prompt: 'scheduled-q', kind: 'reflective_question' },
                  { id: 'p-event', prompt: 'event-q', kind: 'life_event' },
                ],
              },
            },
            200,
          );
        }
        return jsonResponse({ success: true, data: { promptInstanceId: 'p-sched' } }, 200);
      });
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groupsFor('111'),
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      await runOnce(consumer);
      expect(bot.sent).toHaveLength(2);
      expect(bot.sent[0].text).toBe('Reflective question\n\nscheduled-q');
      expect(bot.sent[1].text).toBe('Life event\n\nevent-q');
    }

    for (const kindValue of [null, 'some-future-kind'] as const) {
      _initTestDatabase();
      const bot = makeBot();
      const { fetchImpl } = makeFetch((url) => {
        if (url.includes('/telegram-outbox')) {
          return jsonResponse(
            { success: true, data: { deliveries: [{ promptInstanceId: 'p-h', prompt: 'hq', kind: kindValue }] } },
            200,
          );
        }
        return jsonResponse({ success: true, data: { promptInstanceId: 'p-h' } }, 200);
      });
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groupsFor('111'),
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      await runOnce(consumer);
      expect(bot.sent).toHaveLength(1);
      expect(bot.sent[0].text).toBe(`Conversation starter\n\nhq`);
    }

    const legacyShapes: Array<Record<string, unknown>> = [
      { promptInstanceId: 'p-l1', kind: 'morning', promptText: 'legacy-1' },
      { prompt_instance_id: 'p-l2', kind: 'evening', prompt_text: 'legacy-2' },
      { id: 'p-l3', kind: 'nudge', text: 'legacy-3' },
    ];
    for (const record of legacyShapes) {
      _initTestDatabase();
      const bot = makeBot();
      const { fetchImpl } = makeFetch((url) => {
        if (url.includes('/telegram-outbox')) {
          return jsonResponse({ success: true, data: { deliveries: [record] } }, 200);
        }
        const id = String(record['promptInstanceId'] ?? record['prompt_instance_id'] ?? record['id']);
        return jsonResponse({ success: true, data: { promptInstanceId: id } }, 200);
      });
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groupsFor('111'),
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      await runOnce(consumer);
      expect(bot.sent).toHaveLength(1);
    }

    const malformed: unknown[] = [
      { success: true, data: { deliveries: [{ prompt: 'q', kind: 'reflective_question' }] } },
      { success: true, data: { deliveries: [{ promptInstanceId: 'p-m', kind: 'reflective_question' }] } },
      { success: true, data: { deliveries: [{ promptInstanceId: 'p-m', prompt: '', kind: 'reflective_question' }] } },
      { success: true, data: { deliveries: [{ promptInstanceId: 'p-m', prompt: 'q' }] } },
      { success: true, data: { deliveries: [{ promptInstanceId: 'p-m', prompt: 'q', kind: '' }] } },
      { success: true, data: { deliveries: [{ promptInstanceId: 'p-m', prompt: 'q', kind: 123 }] } },
      { success: true, data: { deliveries: [{ promptInstanceId: 'p-m', promptText: 'q' }] } },
      { success: true, data: { deliveries: [{ promptInstanceId: '', prompt: 'q', kind: 'reflective_question' }] } },
    ];
    for (const body of malformed) {
      _initTestDatabase();
      const bot = makeBot();
      const { fetchImpl } = makeFetch((url) => {
        if (url.includes('/telegram-outbox')) return jsonResponse(body, 200);
        return jsonResponse({ success: true, data: {} }, 200);
      });
      const consumer = new LifePromptDeliveryConsumer({
        configProvider: () => config(),
        groupsProvider: () => groupsFor('111'),
        botProvider: () => bot.adapter,
        fetchImpl,
      });
      await runOnce(consumer);
      expect(bot.sent).toHaveLength(0);
    }
  });

  it('preserves Life prompt part boundaries and resumes a retained first-part receipt', async () => {
    const kinds: Array<{ kind: string; label: string }> = [
      { kind: 'reflective_question', label: 'Reflective question' },
      { kind: 'ai_follow_up', label: 'AI follow-up' },
      { kind: 'archive_gap', label: 'Archive gap' },
      { kind: 'recording_gap', label: 'Recording gap' },
      { kind: 'recent_entry_follow_up', label: 'Recent follow-up' },
      { kind: 'life_event', label: 'Life event' },
    ];
    const baseHeader = 'Conversation starter\n\n';
    for (const { kind, label } of kinds) {
      for (const promptLen of [TELEGRAM_PROMPT_MAX_LENGTH - baseHeader.length, TELEGRAM_PROMPT_MAX_LENGTH - baseHeader.length + 1]) {
        const promptText = 'q'.repeat(promptLen);
        const former = splitTelegramParts(`${baseHeader}${promptText}`);
        const actual = buildPromptParts(kind, promptText);
        expect(actual).toHaveLength(former.length);
        for (const part of actual) {
          expect(part.length).toBeLessThanOrEqual(TELEGRAM_PROMPT_MAX_LENGTH);
        }
        expect(actual.slice(1)).toEqual(former.slice(1));
        const expectedFirstBody = former[0].slice(baseHeader.length);
        expect(actual[0]).toBe(`${label}\n\n${expectedFirstBody}`);
        expect(buildPromptText(kind, promptText)).toBe(`${label}\n\n${promptText}`);
      }
    }

    _initTestDatabase();
    const promptText = 'r'.repeat(TELEGRAM_PROMPT_MAX_LENGTH);
    const kind = 'reflective_question';
    const expectedParts = buildPromptParts(kind, promptText);
    expect(expectedParts).toHaveLength(2);
    const scope: LifePromptDeliveryScope = {
      endpoint: BASE_URL,
      journalId: JOURNAL_ID,
      credentialFingerprint: credentialFingerprint(SECRET_TOKEN),
      destination: 'tg:111',
    };
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'p-resume',
      partIndex: 0,
      partCount: expectedParts.length,
      telegramMessageId: 777,
      sourceMessageKey: 'telegram:111:777',
    });
    const bot = makeBot();
    const ackBodies: string[] = [];
    const { fetchImpl } = makeFetch((url, init) => {
      if (url.includes('/telegram-outbox')) {
        return jsonResponse(
          { success: true, data: { deliveries: [{ promptInstanceId: 'p-resume', prompt: promptText, kind }] } },
          200,
        );
      }
      ackBodies.push(String(init?.body));
      return jsonResponse({ success: true, data: { promptInstanceId: 'p-resume' } }, 200);
    });
    const consumer = new LifePromptDeliveryConsumer({
      configProvider: () => config(),
      groupsProvider: () => groupsFor('111'),
      botProvider: () => bot.adapter,
      fetchImpl,
    });
    await runOnce(consumer);
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].text).toBe(expectedParts[1]);
    expect(ackBodies).toHaveLength(1);
    const ackBody = JSON.parse(ackBodies[0]) as Record<string, unknown>;
    expect(String(ackBody['sourceMessageKey'])).toContain('777');
    expect(String(ackBody['sourceMessageKey']).length).toBeLessThanOrEqual(256);
    const receipts = getLifePromptDeliveryReceipts(scope, 'p-resume');
    expect(receipts).toHaveLength(2);
    expect(isLifePromptDeliveryAcknowledged(scope, 'p-resume')).toBe(true);
  });
});
