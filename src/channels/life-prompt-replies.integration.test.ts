import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, _setLifePromptDeliveriesDb } from '../db/index.js';
import {
  insertLifePromptDeliveryReceipt,
  markLifePromptDeliveryAcknowledged,
  type LifePromptDeliveryScope,
} from '../db/life-prompt-deliveries.js';
import {
  credentialFingerprint,
  normalizeEndpoint,
} from './life-prompt-delivery.js';
import { TelegramChannel } from './telegram.js';
import type { TelegramChannelOpts } from './telegram.js';

vi.mock('../db/tool-events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/tool-events.js')>();
  return { ...actual, getRecentToolEvents: vi.fn(() => []) };
});

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const promptConsumerRecords: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> =
  vi.hoisted(() => []);

vi.mock('./life-prompt-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./life-prompt-delivery.js')>();
  class StubLifePromptDeliveryConsumer {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    constructor() {
      this.start = vi.fn();
      this.stop = vi.fn();
      promptConsumerRecords.push(this as unknown as (typeof promptConsumerRecords)[number]);
    }
  }
  return { ...actual, LifePromptDeliveryConsumer: StubLifePromptDeliveryConsumer };
});

let lastBotInstance: any = null;
const setLastBotInstance = (bot: unknown) => {
  lastBotInstance = bot;
};

vi.mock('grammy', () => {
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
  return { Bot: MockBot, Api: vi.fn(), webhookCallback: vi.fn(() => vi.fn()) };
});

const LIFE_ENV = {
  LIFE_API_URL: 'https://life.example.com',
  LIFE_JOURNAL_ID: 'journal-1',
  LIFE_API_TOKEN: 'test-token-abc',
};

function setLifeEnv(overrides: Partial<typeof LIFE_ENV> = {}) {
  process.env.LIFE_API_URL = overrides.LIFE_API_URL ?? LIFE_ENV.LIFE_API_URL;
  process.env.LIFE_JOURNAL_ID = overrides.LIFE_JOURNAL_ID ?? LIFE_ENV.LIFE_JOURNAL_ID;
  process.env.LIFE_API_TOKEN = overrides.LIFE_API_TOKEN ?? LIFE_ENV.LIFE_API_TOKEN;
}

function clearLifeEnv() {
  delete process.env.LIFE_API_URL;
  delete process.env.LIFE_JOURNAL_ID;
  delete process.env.LIFE_API_TOKEN;
}

function currentScope(destination = 'tg:111'): LifePromptDeliveryScope {
  return {
    endpoint: normalizeEndpoint(process.env.LIFE_API_URL ?? LIFE_ENV.LIFE_API_URL),
    journalId: process.env.LIFE_JOURNAL_ID ?? LIFE_ENV.LIFE_JOURNAL_ID,
    credentialFingerprint: credentialFingerprint(
      process.env.LIFE_API_TOKEN ?? LIFE_ENV.LIFE_API_TOKEN,
    ),
    destination,
  };
}

function makeOpts(groups: Record<string, unknown> = { 'tg:111': { folder: 'ceo' } }): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => groups as Record<string, any>),
  };
}

function getTextHandler(bot: any) {
  const call = bot.on.mock.calls.find((c: any) => c[0] === 'message:text');
  return call?.[1];
}

function makeReplyCtx(overrides: any = {}) {
  return {
    message: {
      text: 'my morning note',
      date: Date.now() / 1000,
      message_id: 900,
      reply_to_message: { message_id: 501 },
    },
    chat: { id: 111, type: 'private' },
    from: { id: 111, first_name: 'Ceo' },
    reply: vi.fn().mockResolvedValue(undefined),
    me: { username: 'test_bot' },
    ...overrides,
  };
}

function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('life prompt text reply forwarding (production path)', () => {
  beforeEach(() => {
    _initTestDatabase();
    clearLifeEnv();
    setLifeEnv();
    lastBotInstance = null;
    promptConsumerRecords.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearLifeEnv();
  });

  it('forwards a multipart prompt reply with promptInstanceId and incoming source key', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-multi-1',
      partIndex: 0,
      partCount: 2,
      telegramMessageId: 501,
      sourceMessageKey: 'telegram:111:501',
    });
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-multi-1',
      partIndex: 1,
      partCount: 2,
      telegramMessageId: 502,
      sourceMessageKey: 'telegram:111:501.502',
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonRes({ success: true, data: { captureId: 'cap-1', entryId: 42 } }, 201));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeReplyCtx({ message: { ...makeReplyCtx().message, reply_to_message: { message_id: 502 } } });
    await getTextHandler(lastBotInstance)(ctx);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toBe('https://life.example.com/api/v1/journals/journal-1/text/captures');
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({
      sourceMessageKey: 'telegram:111:900',
      text: 'my morning note',
      promptInstanceId: 'prompt-multi-1',
    });
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Saved'));
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('resolves before acknowledgment and reuses persisted receipts with stable redelivery', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-pending-1',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 511,
      sourceMessageKey: 'telegram:111:511',
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonRes({ success: true, data: { captureId: 'cap-d', entryId: 9, replayed: true } }, 200),
      );
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getTextHandler(lastBotInstance);
    const ctx1 = makeReplyCtx({ message: { text: 'same', date: Date.now() / 1000, message_id: 901, reply_to_message: { message_id: 511 } } });
    const ctx2 = makeReplyCtx({ message: { text: 'same', date: Date.now() / 1000, message_id: 901, reply_to_message: { message_id: 511 } } });
    await handler(ctx1);
    markLifePromptDeliveryAcknowledged(scope, 'prompt-pending-1');
    await handler(ctx2);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const b1 = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    const b2 = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
    expect(b1).toEqual(b2);
    expect(b1['promptInstanceId']).toBe('prompt-pending-1');
    expect(b1['sourceMessageKey']).toBe('telegram:111:901');
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('matches trailing-slash endpoint configuration to normalized receipts', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-slash',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 521,
      sourceMessageKey: 'telegram:111:521',
    });
    setLifeEnv({ LIFE_API_URL: 'https://life.example.com///' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeReplyCtx({ message: { text: 'hi', date: Date.now() / 1000, message_id: 902, reply_to_message: { message_id: 521 } } });
    await getTextHandler(lastBotInstance)(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body['promptInstanceId']).toBe('prompt-slash');
    await ch.disconnect();
  });

  it('leaves foreign-scope replies to ordinary handling without a Life request', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope: { ...scope, credentialFingerprint: 'fp-foreign' },
      promptInstanceId: 'prompt-foreign',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 531,
      sourceMessageKey: 'telegram:111:531',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
    );
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeReplyCtx({ message: { text: 'hello', date: Date.now() / 1000, message_id: 903, reply_to_message: { message_id: 531 } } });
    await getTextHandler(lastBotInstance)(ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    await ch.disconnect();
  });

  it('stops ambiguous replies with contained guidance and no capture', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-a',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 541,
      sourceMessageKey: 'telegram:111:541',
    });
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-b',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 541,
      sourceMessageKey: 'telegram:111:541',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
    );
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeReplyCtx({ message: { text: 'hi', date: Date.now() / 1000, message_id: 904, reply_to_message: { message_id: 541 } } });
    await getTextHandler(lastBotInstance)(ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('ambiguous'));
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('leaves unknown replies to ordinary handling', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
    );
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeReplyCtx();
    await getTextHandler(lastBotInstance)(ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    await ch.disconnect();
  });

  it('refuses non-private, non-ceo, intruder and multi-destination replies', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-1',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 551,
      sourceMessageKey: 'telegram:111:551',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
    );
    const base = () => makeReplyCtx({ message: { text: 'hi', date: Date.now() / 1000, message_id: 905, reply_to_message: { message_id: 551 } } });

    for (const ctxOverride of [
      { chat: { id: 111, type: 'group' } },
      { from: { id: 999 } },
    ]) {
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      await getTextHandler(lastBotInstance)(makeReplyCtx(ctxOverride));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      await ch.disconnect();
    }

    {
      const opts = makeOpts({ 'tg:111': { folder: 'ops' } as any });
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = base();
      await getTextHandler(lastBotInstance)(ctx);
      expect(fetchSpy).not.toHaveBeenCalled();
      await ch.disconnect();
    }

    {
      const opts = makeOpts({
        'tg:111': { folder: 'ceo' } as any,
        'tg:222': { folder: 'ceo' } as any,
      });
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = base();
      await getTextHandler(lastBotInstance)(ctx);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      await ch.disconnect();
    }
  });

  it('routes matched replies before pending decision flows with one decision', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-pending-flow',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 561,
      sourceMessageKey: 'telegram:111:561',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('/decisions/')) return { ok: true } as Response;
      return jsonRes({ success: true, data: { captureId: 'cap-1', entryId: 1 } }, 201);
    });
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const cbHandler = lastBotInstance.on.mock.calls.find((c: any) => c[0] === 'callback_query:data')?.[1];
    await cbHandler({
      callbackQuery: { data: 'decision:reject:dec-life-1' },
      chat: { id: 111 },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = makeReplyCtx({ message: { text: 'prompt follow-up', date: Date.now() / 1000, message_id: 906, reply_to_message: { message_id: 561 } } });
    await getTextHandler(lastBotInstance)(ctx);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/text/captures'))).toBe(true);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/decisions/dec-life-1'))).toBe(false);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Saved'));
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('preserves slash commands without capture', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-1',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 571,
      sourceMessageKey: 'telegram:111:571',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
    );
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = {
      message: { text: '/life hello', date: Date.now() / 1000, message_id: 907, reply_to_message: { message_id: 571 } },
      chat: { id: 111, type: 'private' },
      from: { id: 111 },
      reply: vi.fn().mockResolvedValue(undefined),
      me: { username: 'test_bot' },
    };
    await getTextHandler(lastBotInstance)(ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('rejects blank and oversized matched replies without a Life request', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-1',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 581,
      sourceMessageKey: 'telegram:111:581',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
    );
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getTextHandler(lastBotInstance);
    const blank = makeReplyCtx({ message: { text: '   ', date: Date.now() / 1000, message_id: 908, reply_to_message: { message_id: 581 } } });
    await handler(blank);
    expect(blank.reply).toHaveBeenCalledWith(expect.stringContaining('rejected'));
    const big = makeReplyCtx({ message: { text: 'x'.repeat(20001), date: Date.now() / 1000, message_id: 909, reply_to_message: { message_id: 581 } } });
    await handler(big);
    expect(big.reply).toHaveBeenCalledWith(expect.stringContaining('rejected'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('preserves rejected and unconfirmed outcomes without unassociated fallback', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-1',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 591,
      sourceMessageKey: 'telegram:111:591',
    });
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getTextHandler(lastBotInstance);

    const conflictSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ success: false }, 409));
    const conflictCtx = makeReplyCtx({ message: { text: 'hi', date: Date.now() / 1000, message_id: 910, reply_to_message: { message_id: 591 } } });
    await handler(conflictCtx);
    expect(conflictCtx.reply).toHaveBeenCalledWith(expect.stringContaining('rejected'));
    expect(opts.onMessage).not.toHaveBeenCalled();
    conflictSpy.mockRestore();

    const serverSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ success: false }, 500));
    const serverCtx = makeReplyCtx({ message: { text: 'hi', date: Date.now() / 1000, message_id: 911, reply_to_message: { message_id: 591 } } });
    await handler(serverCtx);
    expect(serverCtx.reply).toHaveBeenCalledWith(expect.stringContaining('unconfirmed'));
    expect(opts.onMessage).not.toHaveBeenCalled();
    serverSpy.mockRestore();
    await ch.disconnect();
  });
});

describe('life prompt voice reply forwarding (production path)', () => {
  const VOICE_AUDIO = 'VOICE-BYTES-xyz-123-prompt-reply';
  const CAP_VOICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function getVoiceHandler(bot: any) {
    const call = bot.on.mock.calls.find((c: any) => c[0] === 'message:voice');
    return call?.[1];
  }

  function makeVoiceReplyCtx(overrides: any = {}) {
    return {
      message: {
        message_id: 920,
        date: Date.now() / 1000,
        voice: {
          file_id: 'file-voice-1',
          file_size: 1000,
          duration: 7,
          mime_type: 'audio/ogg',
        },
        reply_to_message: { message_id: 701 },
      },
      chat: { id: 111, type: 'private' },
      from: { id: 111, first_name: 'Ceo' },
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: 'voice/prompt_701.ogg' }),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      me: { username: 'test_bot' },
      ...overrides,
    };
  }

  function voiceReceiptUrl(): string {
    return 'https://life.example.com/api/v1/journals/journal-1/voice/captures';
  }

  function mockVoiceTransport(
    lifeHandler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('api.telegram.org')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            new TextEncoder().encode(VOICE_AUDIO).buffer as ArrayBuffer,
        } as Response;
      }
      return lifeHandler(url, init);
    });
  }

  function lifeCompleted(captureId: string) {
    return (url: string) => {
      if (url === voiceReceiptUrl()) {
        return jsonRes(
          { success: true, data: { captureId, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonRes(
          {
            success: true,
            data: { captureId, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonRes(
          { success: true, data: { captureId, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected life url ${url}`);
    };
  }

  function lifeCallsForReceipt(spy: ReturnType<typeof vi.spyOn>): Array<{ url: string; init?: RequestInit }> {
    return spy.mock.calls
      .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit | undefined }))
      .filter((c) => c.url.includes('/voice/captures'));
  }

  beforeEach(() => {
    _initTestDatabase();
    clearLifeEnv();
    setLifeEnv();
    lastBotInstance = null;
    promptConsumerRecords.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearLifeEnv();
  });

  it('forwards a matched voice reply with unchanged audio and promptInstanceId on the initial receipt', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-1',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 701,
      sourceMessageKey: 'telegram:111:701',
    });
    const fetchSpy = mockVoiceTransport(lifeCompleted(CAP_VOICE));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeVoiceReplyCtx();
    await getVoiceHandler(lastBotInstance)(ctx);

    expect(ctx.api.getFile).toHaveBeenCalledWith('file-voice-1');
    const lifeCalls = lifeCallsForReceipt(fetchSpy);
    expect(lifeCalls).toHaveLength(3);
    const receiptBody = lifeCalls[0].init?.body;
    expect(receiptBody).toBeInstanceOf(FormData);
    const form = receiptBody as FormData;
    expect(form.get('sourceMessageKey')).toBe('telegram:111:920');
    expect(form.get('promptInstanceId')).toBe('prompt-voice-1');
    const audioPart = form.get('audio') as Blob;
    expect(audioPart).toBeInstanceOf(Blob);
    expect(await audioPart.text()).toBe(VOICE_AUDIO);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Saved'));
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('resolves a multipart prompt part and reuses persisted receipts with stable redelivery', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-multi',
      partIndex: 0,
      partCount: 2,
      telegramMessageId: 711,
      sourceMessageKey: 'telegram:111:711',
    });
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-multi',
      partIndex: 1,
      partCount: 2,
      telegramMessageId: 712,
      sourceMessageKey: 'telegram:111:711.712',
    });
    const fetchSpy = mockVoiceTransport(lifeCompleted(CAP_VOICE));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getVoiceHandler(lastBotInstance);
    const ctx1 = makeVoiceReplyCtx({
      message: {
        message_id: 921,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, duration: 3, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 712 },
      },
    });
    const ctx2 = makeVoiceReplyCtx({
      message: {
        message_id: 921,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, duration: 3, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 712 },
      },
    });
    await handler(ctx1);
    markLifePromptDeliveryAcknowledged(scope, 'prompt-voice-multi');
    await handler(ctx2);

    const lifeCalls = lifeCallsForReceipt(fetchSpy);
    expect(lifeCalls).toHaveLength(6);
    const firstReceipt = lifeCalls[0].init?.body as FormData;
    const secondReceipt = lifeCalls[3].init?.body as FormData;
    expect(firstReceipt.get('promptInstanceId')).toBe('prompt-voice-multi');
    expect(secondReceipt.get('promptInstanceId')).toBe('prompt-voice-multi');
    expect(firstReceipt.get('sourceMessageKey')).toBe('telegram:111:921');
    expect(secondReceipt.get('sourceMessageKey')).toBe('telegram:111:921');
    expect(await (firstReceipt.get('audio') as Blob).text()).toBe(VOICE_AUDIO);
    expect(await (secondReceipt.get('audio') as Blob).text()).toBe(VOICE_AUDIO);
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('holds review_in_life without completing and without claiming success', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-review',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 721,
      sourceMessageKey: 'telegram:111:721',
    });
    const fetchSpy = mockVoiceTransport((url) => {
      if (url === voiceReceiptUrl()) {
        return jsonRes(
          { success: true, data: { captureId: CAP_VOICE, state: 'unresolved' } },
          201,
        );
      }
      throw new Error(`unexpected life url ${url}`);
    });
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeVoiceReplyCtx({
      message: {
        message_id: 922,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 721 },
      },
    });
    await getVoiceHandler(lastBotInstance)(ctx);

    const lifeCalls = lifeCallsForReceipt(fetchSpy);
    expect(lifeCalls).toHaveLength(1);
    expect(lifeCalls[0].url).toBe(voiceReceiptUrl());
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/review/i));
    expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('Saved'));
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('rejects association failures without unassociated fallback', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-fail',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 731,
      sourceMessageKey: 'telegram:111:731',
    });
    const fetchSpy = mockVoiceTransport(() =>
      jsonRes({ success: false, code: 'invalid_audio' }, 422),
    );
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeVoiceReplyCtx({
      message: {
        message_id: 923,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 731 },
      },
    });
    await getVoiceHandler(lastBotInstance)(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/fail/i));
    expect(opts.onMessage).not.toHaveBeenCalled();
    const lifeCalls = lifeCallsForReceipt(fetchSpy);
    expect(lifeCalls).toHaveLength(1);
    expect((lifeCalls[0].init?.body as FormData).get('promptInstanceId')).toBe(
      'prompt-voice-fail',
    );
    await ch.disconnect();
  });

  it('contains lookup errors without capture or fallback', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-lookup',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 741,
      sourceMessageKey: 'telegram:111:741',
    });
    const fetchSpy = mockVoiceTransport(lifeCompleted(CAP_VOICE));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getVoiceHandler(lastBotInstance);
    _setLifePromptDeliveriesDb(undefined as any);
    const ctx = makeVoiceReplyCtx({
      message: {
        message_id: 924,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 741 },
      },
    });
    try {
      await handler(ctx);
    } finally {
      _initTestDatabase();
    }
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.api.getFile).not.toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('stops ambiguous voice replies without capture', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-a',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 751,
      sourceMessageKey: 'telegram:111:751',
    });
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-b',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 751,
      sourceMessageKey: 'telegram:111:751',
    });
    const fetchSpy = mockVoiceTransport(lifeCompleted(CAP_VOICE));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeVoiceReplyCtx({
      message: {
        message_id: 925,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 751 },
      },
    });
    await getVoiceHandler(lastBotInstance)(ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/ambiguous/i));
    expect(opts.onMessage).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('keeps owner and scope isolation without prompt binding and with one routing decision', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope,
      promptInstanceId: 'prompt-voice-iso',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 761,
      sourceMessageKey: 'telegram:111:761',
    });
    const fetchSpy = mockVoiceTransport(lifeCompleted('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const handler = getVoiceHandler(lastBotInstance);

    const intruder = makeVoiceReplyCtx({
      from: { id: 999 },
      message: {
        message_id: 926,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 761 },
      },
    });
    await handler(intruder);
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const intruderReceipt = lifeCallsForReceipt(fetchSpy).find((c) => c.url === voiceReceiptUrl())?.init?.body as FormData;
    expect(intruderReceipt).toBeInstanceOf(FormData);
    expect(intruderReceipt.get('promptInstanceId')).toBeNull();
    expect(intruderReceipt.get('sourceMessageKey')).toBe('telegram:111:926');

    const groupType = makeVoiceReplyCtx({
      chat: { id: 111, type: 'group' },
      message: {
        message_id: 927,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 761 },
      },
    });
    await handler(groupType);
    expect(opts.onMessage).toHaveBeenCalledTimes(2);

    fetchSpy.mockRestore();
    await ch.disconnect();
  });

  it('leaves foreign-scope voice replies to the unassociated path without prompt metadata', async () => {
    const scope = currentScope();
    insertLifePromptDeliveryReceipt({
      scope: { ...scope, credentialFingerprint: 'fp-foreign' },
      promptInstanceId: 'prompt-voice-foreign',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 771,
      sourceMessageKey: 'telegram:111:771',
    });
    const fetchSpy = mockVoiceTransport(lifeCompleted('cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeVoiceReplyCtx({
      message: {
        message_id: 928,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 771 },
      },
    });
    await getVoiceHandler(lastBotInstance)(ctx);
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const lifeCalls = lifeCallsForReceipt(fetchSpy);
    expect(lifeCalls.length).toBeGreaterThan(0);
    expect((lifeCalls[0].init?.body as FormData).get('promptInstanceId')).toBeNull();
    expect(ctx.reply).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('retains the unassociated voice path for non-reply voice with real forwarder', async () => {
    const fetchSpy = mockVoiceTransport(lifeCompleted('dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeVoiceReplyCtx({
      message: {
        message_id: 929,
        date: Date.now() / 1000,
        voice: { file_id: 'f1', file_size: 10, duration: 4, mime_type: 'audio/ogg' },
      },
    });
    await getVoiceHandler(lastBotInstance)(ctx);
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const lifeCalls = lifeCallsForReceipt(fetchSpy);
    expect(lifeCalls.length).toBeGreaterThan(0);
    const form = lifeCalls[0].init?.body as FormData;
    expect(form.get('promptInstanceId')).toBeNull();
    expect(form.get('sourceMessageKey')).toBe('telegram:111:929');
    expect(await (form.get('audio') as Blob).text()).toBe(VOICE_AUDIO);
    await ch.disconnect();
  });
});
