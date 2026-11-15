import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TelegramChannel } from './telegram.js';
import type { TelegramChannelOpts } from './telegram.js';
import { logger } from '../logger.js';

vi.mock('../db/tool-events.js', () => ({
  getRecentToolEvents: vi.fn(() => []),
}));

vi.mock('./life-voice-capture.js', () => ({
  forwardVoiceCapture: vi.fn(async () => ({ outcome: 'completed' })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const lifePromptConsumerRecords: Array<{
  deps: any;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pollOnce: ReturnType<typeof vi.fn>;
  running: boolean;
}> = vi.hoisted(() => []);

vi.mock('./life-prompt-delivery.js', () => {
  class StubLifePromptDeliveryConsumer {
    deps: unknown;
    running = false;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    pollOnce: ReturnType<typeof vi.fn>;

    constructor(deps: unknown) {
      this.deps = deps;
      this.start = vi.fn(() => {
        this.running = true;
      });
      this.stop = vi.fn(() => {
        this.running = false;
      });
      this.pollOnce = vi.fn(async () => undefined);
      lifePromptConsumerRecords.push(
        this as unknown as (typeof lifePromptConsumerRecords)[number],
      );
    }
  }
  return { LifePromptDeliveryConsumer: StubLifePromptDeliveryConsumer };
});

let lastBotInstance: any = null;

vi.mock('grammy', () => {
  const setLastBotInstance = (bot: unknown) => {
    lastBotInstance = bot;
  };

  class MockBot {
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 601 }),
      sendChatAction: vi.fn().mockResolvedValue(true),
      setWebhook: vi.fn().mockResolvedValue(true),
      deleteWebhook: vi.fn().mockResolvedValue(true),
      getChat: vi.fn(async () => ({ type: 'private' })),
    };
    botInfo = { username: 'test_bot', id: 123 };
    command = vi.fn();
    on = vi.fn();
    catch = vi.fn();
    start = vi.fn(({ onStart }: any) => {
      onStart({ username: 'test_bot', id: 123 });
    });
    stop = vi.fn();
    init = vi.fn().mockResolvedValue(undefined);

    constructor() {
      setLastBotInstance(this);
    }
  }

  return {
    Bot: MockBot,
    Api: vi.fn(),
    webhookCallback: vi.fn(() => vi.fn()),
  };
});

const SECRET_TOKEN = 'secret-token-xyz-987';
const SECRET_QUESTION = 'secret-integration-question-abc';
const SECRET_ANSWER = 'secret-integration-answer-def';

function makeOpts(): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

function admittedOpts() {
  const opts = makeOpts();
  (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
    'tg:111': { folder: 'ceo' } as any,
  });
  return opts;
}

function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function successBody(
  threadKey: string,
  answer: string,
  overrides: Record<string, unknown> = {},
  status: number,
) {
  void status;
  return {
    success: true,
    data: {
      threadKey,
      turnId: 'turn-1',
      answer,
      generation: 'gen-1',
      entryCount: 2,
      replayed: false,
      ...overrides,
    },
  };
}

function makeAskCtx(overrides: any = {}) {
  return {
    chat: { id: 111, type: 'private' },
    message: {
      message_id: 222,
      date: Date.now() / 1000,
      text: '/lifeask what happened?',
      entities: [{ type: 'bot_command', offset: 0, length: 8 }],
    },
    from: { id: 111, first_name: 'Ceo' },
    match: 'what happened?',
    reply: vi.fn().mockResolvedValue(undefined),
    me: { username: 'test_bot' },
    ...overrides,
  };
}

function getAskHandler(bot: any) {
  const call = bot.command.mock.calls.find((c: any) => c[0] === 'lifeask');
  return call?.[1];
}

function loggedText(): string {
  const mocked = logger as unknown as {
    info: { mock: { calls: unknown[][] } };
    warn: { mock: { calls: unknown[][] } };
    error: { mock: { calls: unknown[][] } };
    debug: { mock: { calls: unknown[][] } };
  };
  const all = [
    ...mocked.info.mock.calls,
    ...mocked.warn.mock.calls,
    ...mocked.error.mock.calls,
    ...mocked.debug.mock.calls,
  ];
  return JSON.stringify(all);
}

describe('life-archive-question integration (production handler + real forwarder)', () => {
  beforeEach(() => {
    lastBotInstance = null;
    lifePromptConsumerRecords.length = 0;
    delete process.env.LIFE_API_URL;
    delete process.env.LIFE_JOURNAL_ID;
    delete process.env.LIFE_API_TOKEN;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LIFE_API_URL;
    delete process.env.LIFE_JOURNAL_ID;
    delete process.env.LIFE_API_TOKEN;
  });

  function setLifeEnv() {
    process.env.LIFE_API_URL = 'https://life.example.com';
    process.env.LIFE_JOURNAL_ID = 'journal-1';
    process.env.LIFE_API_TOKEN = SECRET_TOKEN;
  }

  it('is registered before the generic text handler', async () => {
    const ch = new TelegramChannel('token123', makeOpts());
    await ch.connect();
    expect(getAskHandler(lastBotInstance)).toBeDefined();
    const askIdx = lastBotInstance.command.mock.calls.findIndex(
      (c: any) => c[0] === 'lifeask',
    );
    expect(askIdx).toBeGreaterThanOrEqual(0);
    await ch.disconnect();
  });

  it('asks the canonical receiver and displays the validated answer as plain text', async () => {
    setLifeEnv();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonRes(successBody('telegram:111', 'The archive remembers.'), 201),
      );
    const opts = admittedOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeAskCtx();
    await getAskHandler(lastBotInstance)(ctx);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toBe(
      'https://life.example.com/api/v1/journals/journal-1/archive-questions',
    );
    expect(url).toContain('/api/v1/journals/journal-1/archive-questions');
    expect(url).not.toContain('/text/captures');
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    const bodyJson = JSON.parse(String(init.body));
    expect(bodyJson).toEqual({
      sourceThreadKey: 'telegram:111',
      sourceMessageKey: 'telegram:111:222',
      question: 'what happened?',
    });
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith('The archive remembers.');
    expect(opts.onMessage).not.toHaveBeenCalled();
    const text = loggedText();
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SECRET_QUESTION);
    expect(text).not.toContain(SECRET_ANSWER);
    await ch.disconnect();
  });

  it('submits sequential questions with one thread key and distinct message keys', async () => {
    setLifeEnv();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url: any) =>
        jsonRes(successBody('telegram:111', 'answer'), 201),
    );
    const opts = admittedOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getAskHandler(lastBotInstance);
    await handler(makeAskCtx({ match: 'first question' }));
    await handler(
      makeAskCtx({
        match: 'follow-up question',
        message: {
          message_id: 223,
          date: Date.now() / 1000,
          text: '/lifeask follow-up question',
          entities: [{ type: 'bot_command', offset: 0, length: 8 }],
        },
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const b1 = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    const b2 = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
    expect(b1['sourceThreadKey']).toBe('telegram:111');
    expect(b2['sourceThreadKey']).toBe('telegram:111');
    expect(b1['sourceMessageKey']).toBe('telegram:111:222');
    expect(b2['sourceMessageKey']).toBe('telegram:111:223');
    expect(b1['question']).toBe('first question');
    expect(b2['question']).toBe('follow-up question');
    await ch.disconnect();
  });

  it('handles a stored replay answer on redelivery', async () => {
    setLifeEnv();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonRes(
          successBody('telegram:111', 'Stored answer.', { replayed: true }),
          200,
        ),
      );
    const opts = admittedOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getAskHandler(lastBotInstance);
    const ctx = makeAskCtx({ match: 'same question' });
    await handler(ctx);
    await handler(makeAskCtx({ match: 'same question' }));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      const bodyJson = JSON.parse(String((call[1] as RequestInit).body));
      expect(bodyJson['sourceThreadKey']).toBe('telegram:111');
      expect(bodyJson['sourceMessageKey']).toBe('telegram:111:222');
    }
    expect(ctx.reply).toHaveBeenCalledWith('Stored answer.');
    await ch.disconnect();
  });

  it('delivers long answers in ordered Telegram-sized parts', async () => {
    setLifeEnv();
    const longAnswer = 'x'.repeat(4096) + 'y'.repeat(100) + 'END';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonRes(successBody('telegram:111', longAnswer), 201),
      );
    const opts = admittedOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeAskCtx();
    await getAskHandler(lastBotInstance)(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    const first = String(ctx.reply.mock.calls[0][0]);
    const second = String(ctx.reply.mock.calls[1][0]);
    expect(first.length).toBe(4096);
    expect((first + second)).toBe(longAnswer);
    expect(second.endsWith('END')).toBe(true);
    await ch.disconnect();
  });

  it('makes no Life request for admission refusals', async () => {
    setLifeEnv();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonRes(successBody('telegram:111', 'a'), 201));

    for (const groups of [{}, { 'tg:111': { folder: 'ops' } as any }]) {
      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue(groups);
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeAskCtx();
      await getAskHandler(lastBotInstance)(ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
      await ch.disconnect();
    }

    const groupOpts = admittedOpts();
    const groupCh = new TelegramChannel('token123', groupOpts);
    await groupCh.connect();
    const groupCtx = makeAskCtx({ chat: { id: 111, type: 'group' } });
    await getAskHandler(lastBotInstance)(groupCtx);
    expect(groupCtx.reply).not.toHaveBeenCalled();
    await groupCh.disconnect();

    const senderOpts = admittedOpts();
    const senderCh = new TelegramChannel('token123', senderOpts);
    await senderCh.connect();
    const intruder = makeAskCtx({ from: { id: 999, first_name: 'Intruder' } });
    await getAskHandler(lastBotInstance)(intruder);
    expect(intruder.reply).not.toHaveBeenCalled();
    await senderCh.disconnect();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns bounded guidance without a request for invalid input or missing config', async () => {
    setLifeEnv();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonRes(successBody('telegram:111', 'a'), 201));
    const opts = admittedOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getAskHandler(lastBotInstance);
    const blank = makeAskCtx({ match: '   ' });
    await handler(blank);
    expect(blank.reply).toHaveBeenCalled();
    const big = makeAskCtx({ match: 'x'.repeat(8001) });
    await handler(big);
    expect(big.reply).toHaveBeenCalledWith(expect.stringContaining('rejected'));
    expect(fetchSpy).not.toHaveBeenCalled();
    await ch.disconnect();

    delete process.env.LIFE_API_URL;
    delete process.env.LIFE_JOURNAL_ID;
    delete process.env.LIFE_API_TOKEN;
    const fetchSpy2 = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonRes(successBody('telegram:111', 'a'), 201));
    const opts2 = admittedOpts();
    const ch2 = new TelegramChannel('token123', opts2);
    await ch2.connect();
    const ctx2 = makeAskCtx();
    await getAskHandler(lastBotInstance)(ctx2);
    expect(fetchSpy2).not.toHaveBeenCalled();
    expect(ctx2.reply).toHaveBeenCalledWith(
      expect.stringContaining('unavailable'),
    );
    await ch2.disconnect();
  });

  it('never surfaces failures as successful answers', async () => {
    setLifeEnv();
    const cases: Array<{ status: number; body: unknown; expected: string }> = [
      { status: 401, body: { success: false }, expected: 'rejected' },
      { status: 409, body: { success: false }, expected: 'rejected' },
      { status: 500, body: { success: false }, expected: 'unconfirmed' },
      { status: 201, body: { ok: true }, expected: 'unconfirmed' },
    ];
    for (const c of cases) {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes(c.body, c.status));
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeAskCtx();
      await getAskHandler(lastBotInstance)(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining(c.expected),
      );
      expect(ctx.reply).not.toHaveBeenCalledWith(
        expect.stringContaining('Stored answer'),
      );
      await ch.disconnect();
      fetchSpy.mockRestore();
    }

    const opts = admittedOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const timeoutSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network down'));
    const ctx = makeAskCtx({ match: SECRET_QUESTION });
    await getAskHandler(lastBotInstance)(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('unconfirmed'),
    );
    const text = loggedText();
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SECRET_QUESTION);
    timeoutSpy.mockRestore();
    await ch.disconnect();
  });
});
