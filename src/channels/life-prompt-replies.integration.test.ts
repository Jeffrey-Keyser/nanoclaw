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

vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>();
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
    ...actual,
    Bot: MockBot,
    Api: vi.fn(),
    webhookCallback: vi.fn(() => vi.fn()),
  };
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

describe('ordinary owner voice status (LIFE-LF04-03)', () => {
  const VOICE_AUDIO = 'VOICE-BYTES-xyz-123-prompt-reply';
  const CAP_STATUS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  function getVoiceHandler(bot: any) {
    const call = bot.on.mock.calls.find((c: any) => c[0] === 'message:voice');
    return call?.[1];
  }

  function makeOrdinaryCtx(overrides: any = {}) {
    return {
      message: {
        message_id: 930,
        date: Date.now() / 1000,
        voice: {
          file_id: 'file-ordinary-1',
          file_size: 1000,
          duration: 7,
          mime_type: 'audio/ogg',
        },
      },
      chat: { id: 111, type: 'private' },
      from: { id: 111, first_name: 'Ceo' },
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: 'voice/ordinary_930.ogg' }),
        editMessageText: vi.fn().mockResolvedValue(true),
      },
      reply: vi.fn().mockResolvedValue({ message_id: 801 }),
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

  function lifeCallsForReceipt(spy: ReturnType<typeof vi.spyOn>): Array<{ url: string; init?: RequestInit }> {
    return spy.mock.calls
      .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit | undefined }))
      .filter((c) => c.url.includes('/voice/captures'));
  }

  async function waitForStatus(ctx: any, text: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (
        (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.some(
          (c: any[]) => c[0] === text,
        )
      ) {
        return;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for status ${text}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
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

  it('shows an ordinary owner voice status while Life processing is pending', async () => {
    const { LIFE_VOICE_PROCESSING_STATUS } = await import('./telegram.js');
    let releaseProcess!: (res: Response) => void;
    const processGate = new Promise<Response>((resolve) => {
      releaseProcess = resolve;
    });
    const fetchSpy = mockVoiceTransport((url) => {
      if (url === voiceReceiptUrl()) {
        return jsonRes(
          { success: true, data: { captureId: CAP_STATUS, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) return processGate;
      if (url.endsWith('/complete')) {
        return jsonRes(
          { success: true, data: { captureId: CAP_STATUS, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected life url ${url}`);
    });
    const opts = makeOpts();
    const ch = new TelegramChannel('token123', opts);
    await ch.connect();
    const ctx = makeOrdinaryCtx();
    const done = getVoiceHandler(lastBotInstance)(ctx);

    await waitForStatus(ctx, LIFE_VOICE_PROCESSING_STATUS);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
    const lifeUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(lifeUrls).toContain(voiceReceiptUrl());
    expect(lifeUrls.some((u) => u.endsWith('/process'))).toBe(true);
    expect(lifeUrls.some((u) => u.endsWith('/complete'))).toBe(false);
    expect(opts.onMessage).toHaveBeenCalledTimes(1);

    releaseProcess(
      jsonRes(
        {
          success: true,
          data: { captureId: CAP_STATUS, state: 'unfinished', nextAction: 'complete' },
        },
        200,
      ),
    );
    await done;
    const edit = ctx.api.editMessageText as ReturnType<typeof vi.fn>;
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0][2]).toBe('Saved to Life.');
    await ch.disconnect();
    fetchSpy.mockRestore();

    {
      const receiptOnlySpy = mockVoiceTransport((url) => {
        if (url === voiceReceiptUrl()) {
          return jsonRes(
            { success: true, data: { captureId: CAP_STATUS, state: 'unresolved' } },
            201,
          );
        }
        throw new Error(`unexpected life url ${url}`);
      });
      const opts2 = makeOpts();
      const ch2 = new TelegramChannel('token123', opts2);
      await ch2.connect();
      const ctx2 = makeOrdinaryCtx({
        message: {
          message_id: 931,
          date: Date.now() / 1000,
          voice: { file_id: 'f2', file_size: 10, mime_type: 'audio/ogg' },
        },
      });
      await getVoiceHandler(lastBotInstance)(ctx2);
      expect(ctx2.reply).not.toHaveBeenCalled();
      expect((ctx2.api.editMessageText as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(lifeCallsForReceipt(receiptOnlySpy)).toHaveLength(1);
      await ch2.disconnect();
      receiptOnlySpy.mockRestore();
    }

    {
      const groupSpy = mockVoiceTransport((url) => {
        if (url === voiceReceiptUrl()) {
          return jsonRes(
            { success: true, data: { captureId: CAP_STATUS, state: 'unfinished' } },
            201,
          );
        }
        if (url.endsWith('/process')) {
          return jsonRes(
            {
              success: true,
              data: { captureId: CAP_STATUS, state: 'unfinished', nextAction: 'complete' },
            },
            200,
          );
        }
        if (url.endsWith('/complete')) {
          return jsonRes(
            { success: true, data: { captureId: CAP_STATUS, state: 'completed' } },
            200,
          );
        }
        throw new Error(`unexpected life url ${url}`);
      });
      const opts3 = makeOpts();
      const ch3 = new TelegramChannel('token123', opts3);
      await ch3.connect();
      const ctx3 = makeOrdinaryCtx({ chat: { id: 111, type: 'group' } });
      await getVoiceHandler(lastBotInstance)(ctx3);
      expect(ctx3.reply).not.toHaveBeenCalled();
      expect(lifeCallsForReceipt(groupSpy).length).toBeGreaterThan(0);
      await ch3.disconnect();
      groupSpy.mockRestore();
    }
  }, 15000);

  it('updates voice status from confirmed outcomes and preserves review fallback', async () => {
    const {
      LIFE_VOICE_PROCESSING_STATUS,
      LIFE_VOICE_REVIEW_INSTRUCTION,
      LIFE_VOICE_SAVED_STATUS,
      LIFE_VOICE_UNCONFIRMED_STATUS,
    } = await import('./telegram.js');

    async function runOutcome(
      messageId: number,
      lifeHandler: (url: string) => Response,
      overrides: any = {},
    ) {
      const fetchSpy = mockVoiceTransport(lifeHandler);
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeOrdinaryCtx({
        message: {
          message_id: messageId,
          date: Date.now() / 1000,
          voice: { file_id: `f-${messageId}`, file_size: 10, mime_type: 'audio/ogg' },
        },
        ...overrides,
      });
      await getVoiceHandler(lastBotInstance)(ctx);
      const lifeCalls = lifeCallsForReceipt(fetchSpy);
      await ch.disconnect();
      fetchSpy.mockRestore();
      return { ctx, lifeCalls, opts };
    }

    const completedHandler = (url: string) => {
      if (url === voiceReceiptUrl()) {
        return jsonRes(
          { success: true, data: { captureId: CAP_STATUS, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonRes(
          {
            success: true,
            data: { captureId: CAP_STATUS, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonRes(
          { success: true, data: { captureId: CAP_STATUS, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected life url ${url}`);
    };
    {
      const { ctx } = await runOutcome(940, completedHandler);
      expect(ctx.reply).toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
      const edit = ctx.api.editMessageText as ReturnType<typeof vi.fn>;
      expect(edit).toHaveBeenCalledTimes(1);
      expect(edit.mock.calls[0][2]).toBe(LIFE_VOICE_SAVED_STATUS);
      const allText = [
        String(ctx.reply.mock.calls[0][0]),
        String(edit.mock.calls[0][2]),
      ].join(' ');
      expect(allText).not.toContain(CAP_STATUS);
      expect(allText).not.toContain(VOICE_AUDIO);
      expect(allText).not.toContain('test-token-abc');
    }

    const reviewHandler = (url: string) => {
      if (url === voiceReceiptUrl()) {
        return jsonRes(
          { success: true, data: { captureId: CAP_STATUS, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonRes(
          {
            success: true,
            data: { captureId: CAP_STATUS, state: 'review_ready', nextAction: 'resolve' },
          },
          200,
        );
      }
      throw new Error(`unexpected life url ${url}`);
    };
    {
      const { ctx } = await runOutcome(941, reviewHandler);
      expect(ctx.reply).toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
      const edit = ctx.api.editMessageText as ReturnType<typeof vi.fn>;
      expect(edit).toHaveBeenCalledTimes(1);
      expect(edit.mock.calls[0][2]).toBe(LIFE_VOICE_REVIEW_INSTRUCTION);
      expect(String(edit.mock.calls[0][2])).toContain('Today');
      const allText = [
        String(ctx.reply.mock.calls[0][0]),
        String(edit.mock.calls[0][2]),
      ].join(' ');
      expect(allText).not.toContain(CAP_STATUS);
      expect(allText).not.toContain(VOICE_AUDIO);
      const replyCalls = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
      expect(replyCalls.length).toBe(1);
    }

    const failedHandler = (url: string) => {
      if (url === voiceReceiptUrl()) {
        return jsonRes(
          { success: true, data: { captureId: CAP_STATUS, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonRes(
          {
            success: true,
            data: { captureId: CAP_STATUS, state: 'failed', code: 'transcription_failed' },
          },
          200,
        );
      }
      throw new Error(`unexpected life url ${url}`);
    };
    {
      const { ctx } = await runOutcome(942, failedHandler);
      expect(ctx.reply).toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
      const edit = ctx.api.editMessageText as ReturnType<typeof vi.fn>;
      expect(edit).toHaveBeenCalledTimes(1);
      expect(edit.mock.calls[0][2]).toBe(LIFE_VOICE_UNCONFIRMED_STATUS);
      const allText = [
        String(ctx.reply.mock.calls[0][0]),
        String(edit.mock.calls[0][2]),
      ].join(' ');
      expect(allText).not.toContain(CAP_STATUS);
      expect(allText).not.toContain('transcription_failed');
      expect(allText).not.toContain(VOICE_AUDIO);
    }

    {
      const fetchSpy = mockVoiceTransport(reviewHandler);
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeOrdinaryCtx({
        message: {
          message_id: 943,
          date: Date.now() / 1000,
          voice: { file_id: 'f-943', file_size: 10, mime_type: 'audio/ogg' },
        },
      });
      (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('edit down'),
      );
      await getVoiceHandler(lastBotInstance)(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
      expect(ctx.reply).toHaveBeenCalledWith(LIFE_VOICE_REVIEW_INSTRUCTION);
      await ch.disconnect();
      fetchSpy.mockRestore();
    }

    {
      const fetchSpy = mockVoiceTransport(reviewHandler);
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const reply = vi
        .fn()
        .mockRejectedValueOnce(new Error('send down'))
        .mockResolvedValue({ message_id: 802 });
      const ctx = makeOrdinaryCtx({
        message: {
          message_id: 944,
          date: Date.now() / 1000,
          voice: { file_id: 'f-944', file_size: 10, mime_type: 'audio/ogg' },
        },
        reply,
      });
      await getVoiceHandler(lastBotInstance)(ctx);
      expect(reply).toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
      expect(reply).toHaveBeenCalledWith(LIFE_VOICE_REVIEW_INSTRUCTION);
      await ch.disconnect();
      fetchSpy.mockRestore();
    }
  }, 15000);

  it('contains status deadlines and failures while preserving capture requests and reply routing', async () => {
    const {
      LIFE_VOICE_PROCESSING_STATUS,
      LIFE_VOICE_STATUS_TIMEOUT_MS,
    } = await import('./telegram.js');
    expect(LIFE_VOICE_STATUS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LIFE_VOICE_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(10000);

    const completedHandler = (url: string) => {
      if (url === voiceReceiptUrl()) {
        return jsonRes(
          { success: true, data: { captureId: CAP_STATUS, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonRes(
          {
            success: true,
            data: { captureId: CAP_STATUS, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonRes(
          { success: true, data: { captureId: CAP_STATUS, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected life url ${url}`);
    };

    {
      const fetchSpy = mockVoiceTransport(completedHandler);
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeOrdinaryCtx({
        message: {
          message_id: 950,
          date: Date.now() / 1000,
          voice: { file_id: 'f-950', file_size: 10, duration: 4, mime_type: 'audio/ogg' },
        },
        reply: vi.fn().mockRejectedValue(new Error('send down')),
      });
      await getVoiceHandler(lastBotInstance)(ctx);
      const lifeCalls = lifeCallsForReceipt(fetchSpy);
      expect(lifeCalls).toHaveLength(3);
      expect(lifeCalls[0].url).toBe(voiceReceiptUrl());
      const form = lifeCalls[0].init?.body as FormData;
      expect(form.get('sourceMessageKey')).toBe('telegram:111:950');
      expect(form.get('promptInstanceId')).toBeNull();
      expect(await (form.get('audio') as Blob).text()).toBe(VOICE_AUDIO);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      await ch.disconnect();
      fetchSpy.mockRestore();
    }

    {
      const fetchSpy = mockVoiceTransport(completedHandler);
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeOrdinaryCtx({
        message: {
          message_id: 951,
          date: Date.now() / 1000,
          voice: { file_id: 'f-951', file_size: 10, mime_type: 'audio/ogg' },
        },
      });
      (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('edit down'),
      );
      await getVoiceHandler(lastBotInstance)(ctx);
      expect(lifeCallsForReceipt(fetchSpy)).toHaveLength(3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      await ch.disconnect();
      fetchSpy.mockRestore();
    }

    {
      let releaseReply!: (v: unknown) => void;
      const replyGate = new Promise<unknown>((resolve) => {
        releaseReply = resolve;
      });
      const fetchSpy = mockVoiceTransport(completedHandler);
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeOrdinaryCtx({
        message: {
          message_id: 952,
          date: Date.now() / 1000,
          voice: { file_id: 'f-952', file_size: 10, mime_type: 'audio/ogg' },
        },
        reply: vi.fn().mockReturnValue(replyGate),
      });
      const done = getVoiceHandler(lastBotInstance)(ctx);
      await new Promise((r) => setTimeout(r, 100));
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls).toContain(voiceReceiptUrl());
      expect(urls.some((u) => u.endsWith('/process'))).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
      releaseReply({ message_id: 803 });
      await done;
      expect(lifeCallsForReceipt(fetchSpy)).toHaveLength(3);
      await ch.disconnect();
      fetchSpy.mockRestore();
    }

    {
      const scope = currentScope();
      insertLifePromptDeliveryReceipt({
        scope,
        promptInstanceId: 'prompt-status-routing',
        partIndex: 0,
        partCount: 1,
        telegramMessageId: 781,
        sourceMessageKey: 'telegram:111:781',
      });
      const fetchSpy = mockVoiceTransport(completedHandler);
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeOrdinaryCtx({
        message: {
          message_id: 953,
          date: Date.now() / 1000,
          voice: { file_id: 'f-953', file_size: 10, mime_type: 'audio/ogg' },
          reply_to_message: { message_id: 781 },
        },
      });
      await getVoiceHandler(lastBotInstance)(ctx);
      expect(ctx.reply).not.toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
      expect(ctx.api.editMessageText as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Saved'));
      expect(opts.onMessage).not.toHaveBeenCalled();
      const lifeCalls = lifeCallsForReceipt(fetchSpy);
      expect(lifeCalls).toHaveLength(3);
      expect((lifeCalls[0].init?.body as FormData).get('promptInstanceId')).toBe(
        'prompt-status-routing',
      );
      await ch.disconnect();
      fetchSpy.mockRestore();
    }
  }, 15000);
});

describe('ordinary voice file lookup recovery (LIFE-LF02-01)', () => {
  const VOICE_AUDIO = 'VOICE-BYTES-lookup-recovery-xyz';
  const FILE_ID = 'file-lookup-recovery-1';

  function getVoiceHandler(bot: any) {
    const call = bot.on.mock.calls.find((c: any) => c[0] === 'message:voice');
    return call?.[1];
  }

  function makeLookupCtx(overrides: any = {}) {
    return {
      message: {
        message_id: 960,
        date: Date.now() / 1000,
        voice: {
          file_id: FILE_ID,
          file_size: 1000,
          duration: 19,
          mime_type: 'audio/mpeg',
        },
      },
      chat: { id: 111, type: 'private' },
      from: { id: 111, first_name: 'Ceo' },
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: 'voice/lookup_960.mp3' }),
        editMessageText: vi.fn().mockResolvedValue(true),
      },
      reply: vi.fn().mockResolvedValue({ message_id: 801 }),
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

  function lifeCallsForReceipt(spy: ReturnType<typeof vi.spyOn>): Array<{ url: string; init?: RequestInit }> {
    return spy.mock.calls
      .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit | undefined }))
      .filter((c) => c.url.includes('/voice/captures'));
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

  it.each([
    { kind: 'HttpError', captureId: 'c1c1c1c1-1111-4111-8111-111111111111' },
    { kind: 'GrammyError-503', captureId: 'd2d2d2d2-2222-4222-8222-222222222222' },
  ])(
    'ordinary voice file lookup recovery after $kind preserves bytes and completes',
    async ({ kind, captureId }) => {
      const { LIFE_VOICE_PROCESSING_STATUS, LIFE_VOICE_SAVED_STATUS } =
        await import('./telegram.js');
      const { GrammyError, HttpError } = await import('grammy');
      const firstError =
        kind === 'HttpError'
          ? new HttpError(
              `Network request for 'getFile' failed!`,
              new Error('socket hang up'),
            )
          : new GrammyError(
              `Call to 'getFile' failed!`,
              { ok: false, error_code: 503, description: 'Service Unavailable' } as never,
              'getFile',
              {},
            );

      const fetchSpy = mockVoiceTransport(lifeCompleted(captureId));
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLookupCtx({
        api: {
          getFile: vi
            .fn()
            .mockRejectedValueOnce(firstError)
            .mockResolvedValue({ file_path: 'voice/lookup_960.mp3' }),
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      });
      await getVoiceHandler(lastBotInstance)(ctx);

      expect(ctx.api.getFile).toHaveBeenCalledTimes(2);
      expect(ctx.api.getFile).toHaveBeenNthCalledWith(1, FILE_ID);
      expect(ctx.api.getFile).toHaveBeenNthCalledWith(2, FILE_ID);

      const lifeCalls = lifeCallsForReceipt(fetchSpy);
      expect(lifeCalls).toHaveLength(3);
      expect(lifeCalls[0].url).toBe(voiceReceiptUrl());
      expect(lifeCalls[1].url).toBe(`${voiceReceiptUrl()}/${captureId}/process`);
      expect(lifeCalls[2].url).toBe(`${voiceReceiptUrl()}/${captureId}/complete`);

      const form = lifeCalls[0].init?.body as FormData;
      expect(form.get('sourceMessageKey')).toBe('telegram:111:960');
      expect(form.get('promptInstanceId')).toBeNull();
      expect(form.get('durationSeconds')).toBe('19');
      const audioPart = form.get('audio') as Blob;
      expect(audioPart).toBeInstanceOf(Blob);
      expect(await audioPart.text()).toBe(VOICE_AUDIO);
      expect(audioPart.type).toBe('audio/mpeg');
      expect((audioPart as unknown as { name?: string }).name).toBe('voice.mp3');

      expect(ctx.reply).toHaveBeenCalledWith(LIFE_VOICE_PROCESSING_STATUS);
      const edit = ctx.api.editMessageText as ReturnType<typeof vi.fn>;
      expect(edit).toHaveBeenCalledTimes(1);
      expect(edit.mock.calls[0][2]).toBe(LIFE_VOICE_SAVED_STATUS);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);

      await ch.disconnect();
    },
    15000,
  );
});
