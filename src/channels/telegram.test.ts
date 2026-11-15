import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ToolCallEvent } from '../db/tool-events.js';
import { TelegramChannel } from './telegram.js';
import type { TelegramChannelOpts } from './telegram.js';

vi.mock('../db/tool-events.js', () => ({
  getRecentToolEvents: vi.fn(() => []),
}));

vi.mock('./life-voice-capture.js', () => ({
  forwardVoiceCapture: vi.fn(async () => ({ outcome: 'completed' })),
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

// Track all created bot instances for assertions
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

function makeOpts(): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    lastBotInstance = null;
    lifePromptConsumerRecords.length = 0;
  });

  describe('constructor', () => {
    it('defaults to polling mode when no webhook URL', () => {
      const ch = new TelegramChannel('token123', makeOpts());
      expect(ch.name).toBe('telegram');
    });

    it('enables webhook mode when webhook URL is provided', () => {
      const ch = new TelegramChannel(
        'token123',
        makeOpts(),
        'https://example.com/telegram',
      );
      expect(ch.name).toBe('telegram');
    });
  });

  describe('ownsJid', () => {
    it('returns true for tg: prefixed JIDs', () => {
      const ch = new TelegramChannel('token', makeOpts());
      expect(ch.ownsJid('tg:12345')).toBe(true);
    });

    it('returns false for non-tg JIDs', () => {
      const ch = new TelegramChannel('token', makeOpts());
      expect(ch.ownsJid('wa:12345')).toBe(false);
      expect(ch.ownsJid('slack:C123')).toBe(false);
    });
  });

  describe('polling mode', () => {
    it('connects using bot.start() in polling mode', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      expect(lastBotInstance.api.deleteWebhook).toHaveBeenCalled();
      expect(lastBotInstance.start).toHaveBeenCalled();
      expect(lastBotInstance.init).not.toHaveBeenCalled();
      expect(ch.isConnected()).toBe(true);
    });

    it('stops polling on disconnect', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();
      await ch.disconnect();

      expect(lastBotInstance.stop).toHaveBeenCalled();
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('webhook mode', () => {
    it('connects using bot.init() and setWebhook in webhook mode', async () => {
      const { webhookCallback } = await import('grammy');
      const ch = new TelegramChannel(
        'token123',
        makeOpts(),
        'https://example.com/telegram',
      );
      await ch.connect();

      expect(lastBotInstance.init).toHaveBeenCalled();
      expect(lastBotInstance.start).not.toHaveBeenCalled();
      expect(lastBotInstance.api.setWebhook).toHaveBeenCalledWith(
        'https://example.com/telegram',
        expect.objectContaining({ secret_token: expect.any(String) }),
      );
      expect(webhookCallback).toHaveBeenCalledWith(
        lastBotInstance,
        'http',
        expect.objectContaining({ secretToken: expect.any(String) }),
      );
      expect(ch.isConnected()).toBe(true);

      // Clean up the server
      await ch.disconnect();
    });

    it('deletes webhook and closes server on disconnect', async () => {
      const ch = new TelegramChannel(
        'token123',
        makeOpts(),
        'https://example.com/telegram',
      );
      await ch.connect();
      await ch.disconnect();

      expect(lastBotInstance.api.deleteWebhook).toHaveBeenCalled();
      // bot.stop() should NOT be called in webhook mode
      expect(lastBotInstance.stop).not.toHaveBeenCalled();
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('decision reject reason flow', () => {
    function getHandler(bot: any, event: string) {
      const call = bot.on.mock.calls.find((c: any) => c[0] === event);
      return call?.[1];
    }

    it('reject callback asks for reason instead of calling agency-hq', async () => {
      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const handler = getHandler(lastBotInstance, 'callback_query:data');
      const ctx = {
        callbackQuery: { data: 'decision:reject:dec-123' },
        chat: { id: 99 },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('reason for rejecting'),
      );
    });

    it('reply with reason submits rejection to agency-hq', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
      } as Response);

      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      // First trigger reject callback to set up pending rejection
      const cbHandler = getHandler(lastBotInstance, 'callback_query:data');
      await cbHandler({
        callbackQuery: { data: 'decision:reject:dec-456' },
        chat: { id: 42 },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      });

      // Now send reason via message handler
      const msgHandler = getHandler(lastBotInstance, 'message:text');
      const msgCtx = {
        message: {
          text: 'Too expensive',
          date: Date.now() / 1000,
          message_id: 1,
        },
        chat: { id: 42, type: 'private' },
        from: { id: 1, first_name: 'Test' },
        reply: vi.fn().mockResolvedValue(undefined),
        me: { username: 'test_bot' },
      };

      await msgHandler(msgCtx);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/decisions/dec-456'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            status: 'rejected',
            rationale: 'Too expensive',
          }),
        }),
      );
      expect(msgCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Decision rejected'),
      );
      // Should NOT pass to onMessage
      expect(opts.onMessage).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it('typing skip rejects without rationale', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
      } as Response);

      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      // Set up pending rejection
      const cbHandler = getHandler(lastBotInstance, 'callback_query:data');
      await cbHandler({
        callbackQuery: { data: 'decision:reject:dec-789' },
        chat: { id: 55 },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      });

      // Send 'skip'
      const msgHandler = getHandler(lastBotInstance, 'message:text');
      const msgCtx = {
        message: { text: 'skip', date: Date.now() / 1000, message_id: 2 },
        chat: { id: 55, type: 'private' },
        from: { id: 1, first_name: 'Test' },
        reply: vi.fn().mockResolvedValue(undefined),
        me: { username: 'test_bot' },
      };

      await msgHandler(msgCtx);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/decisions/dec-789'),
        expect.objectContaining({
          body: JSON.stringify({ status: 'rejected', rationale: '' }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it('approve callback still works immediately', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
      } as Response);

      const opts = makeOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const handler = getHandler(lastBotInstance, 'callback_query:data');
      const ctx = {
        callbackQuery: { data: 'decision:approve:dec-100' },
        chat: { id: 77 },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/decisions/dec-100'),
        expect.objectContaining({
          body: JSON.stringify({ status: 'approved' }),
        }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Approved'),
      );

      fetchSpy.mockRestore();
    });
  });

  describe('/music command', () => {
    function getMusicHandler(bot: any) {
      const call = bot.command.mock.calls.find((c: any) => c[0] === 'music');
      return call?.[1];
    }

    it('shows usage when called with no args', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      const ctx = {
        match: '',
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    });

    it('parses mood filter and calls Music Store API', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          tracks: [
            {
              title: 'Chill Vibes',
              artist: 'DJ Test',
              bpm: 100,
              mood: 'chill',
            },
          ],
        }),
      } as Response);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      const ctx = {
        match: 'mood:chill',
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/playlists/smart'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ mood: 'chill' }),
        }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Chill Vibes'),
      );

      fetchSpy.mockRestore();
    });

    it('parses bpm range format (120-140)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          tracks: [{ title: 'Beat', artist: 'A', bpm: 130 }],
        }),
      } as Response);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      await handler({
        match: 'bpm:120-140',
        reply: vi.fn().mockResolvedValue(undefined),
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ bpm_min: 120, bpm_max: 140 }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it('parses single bpm value', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          tracks: [{ title: 'Beat', artist: 'A', bpm: 130 }],
        }),
      } as Response);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      await handler({
        match: 'bpm:130',
        reply: vi.fn().mockResolvedValue(undefined),
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ bpm: 130 }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it('parses combined filters', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ tracks: [{ title: 'T', artist: 'A' }] }),
      } as Response);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      await handler({
        match: 'mood:chill bpm:120-140 energy:high key:Am',
        reply: vi.fn().mockResolvedValue(undefined),
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            mood: 'chill',
            bpm_min: 120,
            bpm_max: 140,
            energy: 'high',
            key: 'Am',
          }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it('caps display at 10 tracks and shows total count', async () => {
      const tracks = Array.from({ length: 15 }, (_, i) => ({
        title: `Track ${i + 1}`,
        artist: 'Artist',
        bpm: 120,
        mood: 'chill',
      }));
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ tracks }),
      } as Response);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      const ctx = {
        match: 'mood:chill',
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);

      const replyText = ctx.reply.mock.calls[0][0] as string;
      expect(replyText).toContain('1. Track 1');
      expect(replyText).toContain('10. Track 10');
      expect(replyText).not.toContain('11. Track 11');
      expect(replyText).toContain('(15 total matches)');

      fetchSpy.mockRestore();
    });

    it('returns friendly message for no results', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ tracks: [] }),
      } as Response);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      const ctx = {
        match: 'mood:angry',
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        'No tracks found matching those filters.',
      );

      fetchSpy.mockRestore();
    });

    it('returns error message for API failures', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      const ctx = {
        match: 'mood:chill',
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        'Music Store is offline — try again later.',
      );

      fetchSpy.mockRestore();
    });

    it('uses MUSIC_STORE_URL env var', async () => {
      process.env.MUSIC_STORE_URL = 'http://music.example.com';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ tracks: [] }),
      } as Response);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getMusicHandler(lastBotInstance);
      await handler({
        match: 'mood:chill',
        reply: vi.fn().mockResolvedValue(undefined),
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://music.example.com/api/v1/playlists/smart',
        expect.any(Object),
      );

      delete process.env.MUSIC_STORE_URL;
      fetchSpy.mockRestore();
    });
  });

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      await ch.sendMessage('tg:12345', 'Hello');

      expect(lastBotInstance.api.sendMessage).toHaveBeenCalledWith(
        '12345',
        'Hello',
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('splits long messages at 4096 char boundary', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const longText = 'x'.repeat(5000);
      await ch.sendMessage('tg:12345', longText);

      // Should be called twice: 4096 + 904
      expect(lastBotInstance.api.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('/activity command', () => {
    function getActivityHandler(bot: any) {
      const call = bot.command.mock.calls.find((c: any) => c[0] === 'activity');
      return call?.[1];
    }

    it('shows no activity message when no events exist', async () => {
      const { getRecentToolEvents } = await import('../db/tool-events.js');
      (getRecentToolEvents as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getActivityHandler(lastBotInstance);
      const ctx = { reply: vi.fn().mockResolvedValue(undefined) };

      handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        'No agent tool activity in the last 5 minutes.',
      );
    });

    it('formats events with emoji prefixes', async () => {
      const { getRecentToolEvents } = await import('../db/tool-events.js');
      const events: ToolCallEvent[] = [
        {
          id: 1,
          session_id: 'sess-1',
          event_type: 'PostToolUse',
          tool_name: 'Bash',
          payload: JSON.stringify({
            group_folder: 'ceo',
            tool_use_id: 'toolu_01',
          }),
          created_at: '2026-04-24 12:30:45',
        },
        {
          id: 2,
          session_id: 'sess-1',
          event_type: 'PostToolUse',
          tool_name: 'Read',
          payload: JSON.stringify({
            group_folder: 'ceo',
            tool_use_id: 'toolu_02',
          }),
          created_at: '2026-04-24 12:30:50',
        },
      ];
      (getRecentToolEvents as ReturnType<typeof vi.fn>).mockReturnValue(events);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getActivityHandler(lastBotInstance);
      const ctx = { reply: vi.fn().mockResolvedValue(undefined) };

      handler(ctx);
      const replyText = ctx.reply.mock.calls[0][0] as string;
      expect(replyText).toContain('Agent Activity');
      expect(replyText).toContain('Bash');
      expect(replyText).toContain('Read');
      // Uses Markdown
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('marks failed events with FAIL suffix', async () => {
      const { getRecentToolEvents } = await import('../db/tool-events.js');
      const events: ToolCallEvent[] = [
        {
          id: 1,
          session_id: 'sess-1',
          event_type: 'PostToolUseFailure',
          tool_name: 'Bash',
          payload: JSON.stringify({
            group_folder: 'ceo',
            tool_use_id: 'toolu_01',
          }),
          created_at: '2026-04-24 12:30:45',
        },
      ];
      (getRecentToolEvents as ReturnType<typeof vi.fn>).mockReturnValue(events);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getActivityHandler(lastBotInstance);
      const ctx = { reply: vi.fn().mockResolvedValue(undefined) };

      handler(ctx);
      const replyText = ctx.reply.mock.calls[0][0] as string;
      expect(replyText).toContain('FAIL');
    });

    it('respects 3500-char cap and shows truncation notice', async () => {
      const { getRecentToolEvents } = await import('../db/tool-events.js');
      // Create enough events to exceed 3500 chars
      const events: ToolCallEvent[] = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        session_id: 'sess-1',
        event_type: 'PostToolUse',
        tool_name: 'LongToolNameForTesting',
        payload: JSON.stringify({
          group_folder: 'long-group-name-for-testing',
          tool_use_id: `toolu_${i}`,
        }),
        created_at: `2026-04-24 12:${String(i).padStart(2, '0')}:00`,
      }));
      (getRecentToolEvents as ReturnType<typeof vi.fn>).mockReturnValue(events);

      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const handler = getActivityHandler(lastBotInstance);
      const ctx = { reply: vi.fn().mockResolvedValue(undefined) };

      handler(ctx);
      const replyText = ctx.reply.mock.calls[0][0] as string;
      expect(replyText.length).toBeLessThanOrEqual(3600); // Allow some padding
      expect(replyText).toContain('truncated');
    });
  });

  describe('message:voice Life forwarding', () => {
    const LIFE_ENV = {
      LIFE_API_URL: 'https://life.example.com',
      LIFE_JOURNAL_ID: 'journal-1',
      LIFE_API_TOKEN: 'test-token-abc',
    };

    function getVoiceHandler(bot: any) {
      const call = bot.on.mock.calls.find((c: any) => c[0] === 'message:voice');
      return call?.[1];
    }

    function makeVoiceCtx(overrides: any = {}) {
      return {
        chat: { id: 111, type: 'private' },
        message: {
          message_id: 222,
          date: Date.now() / 1000,
          voice: {
            file_id: 'file-abc',
            file_size: 1000,
            duration: 12,
            mime_type: 'audio/ogg',
          },
        },
        from: { id: 1, first_name: 'Test' },
        api: {
          getFile: vi
            .fn()
            .mockResolvedValue({ file_path: 'voice/file_123.ogg' }),
        },
        ...overrides,
      };
    }

    function setLifeEnv() {
      process.env.LIFE_API_URL = LIFE_ENV.LIFE_API_URL;
      process.env.LIFE_JOURNAL_ID = LIFE_ENV.LIFE_JOURNAL_ID;
      process.env.LIFE_API_TOKEN = LIFE_ENV.LIFE_API_TOKEN;
    }

    function clearLifeEnv() {
      delete process.env.LIFE_API_URL;
      delete process.env.LIFE_JOURNAL_ID;
      delete process.env.LIFE_API_TOKEN;
    }

    beforeEach(() => {
      clearLifeEnv();
      vi.clearAllMocks();
    });

    it('forwards registered-chat voice via getFile and forwardVoiceCapture with telegram sourceMessageKey', async () => {
      setLifeEnv();
      const { forwardVoiceCapture } = await import(
        './life-voice-capture.js'
      );
      vi.mocked(forwardVoiceCapture).mockResolvedValue({
        outcome: 'completed',
        captureId: 'cap-1',
      });

      const audioText = 'fake-audio-bytes';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          new TextEncoder().encode(audioText).buffer as ArrayBuffer,
      } as Response);

      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const handler = getVoiceHandler(lastBotInstance);
      expect(handler).toBeDefined();
      const ctx = makeVoiceCtx();
      await handler(ctx);

      expect(ctx.api.getFile).toHaveBeenCalledWith('file-abc');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const downloadUrl = String(fetchSpy.mock.calls[0][0]);
      expect(downloadUrl).toContain('https://api.telegram.org/file/bot');
      expect(downloadUrl).toContain('voice/file_123.ogg');

      expect(forwardVoiceCapture).toHaveBeenCalledTimes(1);
      const fwdArg = vi.mocked(forwardVoiceCapture).mock.calls[0][0] as any;
      expect(fwdArg.sourceMessageKey).toBe('telegram:111:222');
      expect(fwdArg.mimeType).toBe('audio/ogg');
      expect(fwdArg.durationSeconds).toBe(12);
      expect(Buffer.from(fwdArg.audio).toString()).toBe(audioText);

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const stored = (opts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as any;
      expect(stored.content).toContain('[Voice message]');

      fetchSpy.mockRestore();
      clearLifeEnv();
    });

    it('invokes the actual forwarder through receipt, process and complete with receiver envelopes', async () => {
      process.env.LIFE_API_URL = 'https://life.example.com';
      process.env.LIFE_JOURNAL_ID = '42';
      process.env.LIFE_API_TOKEN = 'test-token-abc';
      const actual =
        await vi.importActual<typeof import('./life-voice-capture.js')>(
          './life-voice-capture.js',
        );
      const { forwardVoiceCapture } = await import(
        './life-voice-capture.js'
      );
      vi.mocked(forwardVoiceCapture).mockImplementationOnce(
        actual.forwardVoiceCapture,
      );

      const captureId = '99999999-9999-4999-8999-999999999999';
      const audioText = 'actual-forwarder-voice-bytes-xyz';
      const receiptUrl =
        'https://life.example.com/api/v1/journals/42/voice/captures';
      const lifeCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input: any, init?: any) => {
          const url = String(input);
          if (url.includes('api.telegram.org')) {
            return {
              ok: true,
              status: 200,
              arrayBuffer: async () =>
                new TextEncoder().encode(audioText).buffer as ArrayBuffer,
            } as Response;
          }
          lifeCalls.push({ url, init });
          if (url === receiptUrl) {
            return new Response(
              JSON.stringify({
                success: true,
                data: { captureId, state: 'unfinished' },
              }),
              {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          if (url === `${receiptUrl}/${captureId}/process`) {
            return new Response(
              JSON.stringify({
                success: true,
                data: {
                  captureId,
                  state: 'unfinished',
                  nextAction: 'complete',
                },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          if (url === `${receiptUrl}/${captureId}/complete`) {
            return new Response(
              JSON.stringify({
                success: true,
                data: { captureId, state: 'completed' },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          throw new Error(`unexpected url ${url}`);
        });

      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const handler = getVoiceHandler(lastBotInstance);
      expect(handler).toBeDefined();
      const ctx = makeVoiceCtx();
      await handler(ctx);

      expect(ctx.api.getFile).toHaveBeenCalledWith('file-abc');
      expect(lifeCalls).toHaveLength(3);
      expect(lifeCalls[0].url).toBe(receiptUrl);
      expect(lifeCalls[1].url).toBe(`${receiptUrl}/${captureId}/process`);
      expect(lifeCalls[2].url).toBe(`${receiptUrl}/${captureId}/complete`);
      for (const call of lifeCalls) {
        const headers = call.init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer test-token-abc');
      }
      const receiptBody = lifeCalls[0].init?.body;
      expect(receiptBody).toBeInstanceOf(FormData);
      const form = receiptBody as FormData;
      expect(form.get('sourceMessageKey')).toBe('telegram:111:222');
      const audioPart = form.get('audio') as Blob;
      expect(audioPart).toBeInstanceOf(Blob);
      expect(await audioPart.text()).toBe(audioText);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
      clearLifeEnv();
    });

    it('makes no Life or Telegram file request for unregistered chats', async () => {
      setLifeEnv();
      const { forwardVoiceCapture } = await import(
        './life-voice-capture.js'
      );
      vi.mocked(forwardVoiceCapture).mockClear();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true } as Response);

      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({});
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const handler = getVoiceHandler(lastBotInstance);
      const ctx = makeVoiceCtx();
      await handler(ctx);

      expect(ctx.api.getFile).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(forwardVoiceCapture).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      clearLifeEnv();
    });

    it('makes no Life or Telegram file request when Life config is absent', async () => {
      clearLifeEnv();
      const { forwardVoiceCapture } = await import(
        './life-voice-capture.js'
      );
      vi.mocked(forwardVoiceCapture).mockClear();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true } as Response);

      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const handler = getVoiceHandler(lastBotInstance);
      const ctx = makeVoiceCtx();
      await handler(ctx);

      expect(ctx.api.getFile).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(forwardVoiceCapture).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
    });

    it('rejects files over 25 MiB before download', async () => {
      setLifeEnv();
      const { forwardVoiceCapture } = await import(
        './life-voice-capture.js'
      );
      vi.mocked(forwardVoiceCapture).mockClear();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true } as Response);

      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const handler = getVoiceHandler(lastBotInstance);
      const ctx = makeVoiceCtx({
        message: {
          message_id: 222,
          date: Date.now() / 1000,
          voice: {
            file_id: 'file-big',
            file_size: 26 * 1024 * 1024,
            duration: 60,
          },
        },
      });
      await expect(handler(ctx)).resolves.toBeUndefined();

      expect(ctx.api.getFile).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(forwardVoiceCapture).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
      clearLifeEnv();
    });

    it('does not throw when download or forward fails', async () => {
      setLifeEnv();
      const { forwardVoiceCapture } = await import(
        './life-voice-capture.js'
      );

      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const handler = getVoiceHandler(lastBotInstance);

      vi.mocked(forwardVoiceCapture).mockRejectedValueOnce(
        new Error('life down'),
      );
      const fetchOk = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
      } as Response);
      await expect(handler(makeVoiceCtx())).resolves.toBeUndefined();
      expect(opts.onMessage).toHaveBeenCalled();
      fetchOk.mockRestore();

      const opts2 = makeOpts();
      (opts2.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      const ch2 = new TelegramChannel('token123', opts2);
      await ch2.connect();
      const handler2 = getVoiceHandler(lastBotInstance);
      const failingCtx = makeVoiceCtx({
        api: { getFile: vi.fn().mockRejectedValue(new Error('tg down')) },
      });
      await expect(handler2(failingCtx)).resolves.toBeUndefined();
      expect(opts2.onMessage).toHaveBeenCalledTimes(1);

      clearLifeEnv();
    });
  });

  describe('/life text capture command', () => {
    const LIFE_ENV = {
      LIFE_API_URL: 'https://life.example.com',
      LIFE_JOURNAL_ID: 'journal-1',
      LIFE_API_TOKEN: 'test-token-abc',
    };

    function getLifeHandler(bot: any) {
      const call = bot.command.mock.calls.find((c: any) => c[0] === 'life');
      return call?.[1];
    }

    function getTextHandler(bot: any) {
      const call = bot.on.mock.calls.find((c: any) => c[0] === 'message:text');
      return call?.[1];
    }

    function makeLifeCtx(overrides: any = {}) {
      return {
        chat: { id: 111, type: 'private' },
        message: {
          message_id: 222,
          date: Date.now() / 1000,
          text: '/life hello   world!',
          entities: [{ type: 'bot_command', offset: 0, length: 5 }],
        },
        from: { id: 111, first_name: 'Ceo' },
        match: 'hello   world!',
        reply: vi.fn().mockResolvedValue(undefined),
        me: { username: 'test_bot' },
        ...overrides,
      };
    }

    function setLifeEnv() {
      process.env.LIFE_API_URL = LIFE_ENV.LIFE_API_URL;
      process.env.LIFE_JOURNAL_ID = LIFE_ENV.LIFE_JOURNAL_ID;
      process.env.LIFE_API_TOKEN = LIFE_ENV.LIFE_API_TOKEN;
    }

    function clearLifeEnv() {
      delete process.env.LIFE_API_URL;
      delete process.env.LIFE_JOURNAL_ID;
      delete process.env.LIFE_API_TOKEN;
    }

    function jsonRes(body: unknown, status: number): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    function admittedOpts() {
      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      return opts;
    }

    beforeEach(() => {
      clearLifeEnv();
      vi.clearAllMocks();
      vi.unstubAllGlobals?.();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      clearLifeEnv();
    });

    it('is registered before the generic text handler', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();
      expect(getLifeHandler(lastBotInstance)).toBeDefined();
      expect(getTextHandler(lastBotInstance)).toBeDefined();
      const lifeIdx = lastBotInstance.command.mock.calls.findIndex(
        (c: any) => c[0] === 'life',
      );
      expect(lifeIdx).toBeGreaterThanOrEqual(0);
    });

    it('sends wording-preserving payload through the real typed client to the literal path (201 new)', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          jsonRes(
            { success: true, data: { captureId: 'cap-1', entryId: 42 } },
            201,
          ),
        );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const handler = getLifeHandler(lastBotInstance);
      const ctx = makeLifeCtx({ match: 'hello   world!  , keep  spacing.' });
      await handler(ctx);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = String(fetchSpy.mock.calls[0][0]);
      expect(url).toBe(
        'https://life.example.com/api/v1/journals/journal-1/text/captures',
      );
      expect(url).toContain('/api/v1/journals/journal-1/text/captures');
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-token-abc');
      expect(headers['Content-Type']).toBe('application/json');
      const bodyJson = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(bodyJson).toEqual({
        sourceMessageKey: 'telegram:111:222',
        text: 'hello   world!  , keep  spacing.',
      });
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Saved'));
      expect(opts.onMessage).not.toHaveBeenCalled();
      const replyText = String(ctx.reply.mock.calls[0][0]);
      expect(replyText).not.toContain('hello');
    });

    it('reports saved for confirmed replay (200 replayed true) via real client', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          jsonRes(
            {
              success: true,
              data: { captureId: 'cap-r', entryId: 7, replayed: true },
            },
            200,
          ),
        );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(ctx);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Saved'));
    });

    it('uses identical redelivery identity across retries', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          jsonRes(
            {
              success: true,
              data: { captureId: 'cap-d', entryId: 9, replayed: true },
            },
            200,
          ),
        );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const handler = getLifeHandler(lastBotInstance);
      const ctx1 = makeLifeCtx();
      const ctx2 = makeLifeCtx();
      await handler(ctx1);
      await handler(ctx2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const b1 = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
      const b2 = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
      expect(b1['sourceMessageKey']).toBe('telegram:111:222');
      expect(b2['sourceMessageKey']).toBe('telegram:111:222');
      expect(b1).toEqual(b2);
    });

    it('supports bot-qualified commands and trims surrounding whitespace', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
        );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx({
        message: {
          message_id: 222,
          date: Date.now() / 1000,
          text: '/life@test_bot   spaced   out   ',
          entities: [{ type: 'bot_command', offset: 0, length: 13 }],
        },
        match: '  spaced   out   ',
      });
      await getLifeHandler(lastBotInstance)(ctx);
      const bodyJson = JSON.parse(
        String((fetchSpy.mock.calls[0][1] as RequestInit).body),
      ) as Record<string, unknown>;
      expect(bodyJson['text']).toBe('spaced   out');
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Saved'));
    });

    it('rejects conflicts without reporting saved', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes({ success: false }, 409));
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(ctx);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('rejected'),
      );
      expect(ctx.reply).not.toHaveBeenCalledWith(
        expect.stringContaining('Saved'),
      );
    });

    it('returns unconfirmed on malformed envelopes', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes({ ok: true }, 201));
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(ctx);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('unconfirmed'),
      );
    });

    it('returns unconfirmed when entry ID is missing', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          jsonRes({ success: true, data: { captureId: 'cap-x' } }, 201),
        );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('unconfirmed'),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects blank and oversized payloads without a Life request', async () => {
      setLifeEnv();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
      );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const handler = getLifeHandler(lastBotInstance);

      const blankCtx = makeLifeCtx({ match: '   ' });
      await handler(blankCtx);
      expect(blankCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('rejected'),
      );

      const bigCtx = makeLifeCtx({ match: 'x'.repeat(20001) });
      await handler(bigCtx);
      expect(bigCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('rejected'),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns unavailable when Life configuration is missing', async () => {
      clearLifeEnv();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
      );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(ctx);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('unavailable'),
      );
    });

    it('makes no Life request for unregistered, non-ceo, or non-private chats', async () => {
      setLifeEnv();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
      );

      for (const groups of [
        {},
        { 'tg:111': { folder: 'ops' } as any },
      ]) {
        const opts = makeOpts();
        (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue(
          groups,
        );
        const ch = new TelegramChannel('token123', opts);
        await ch.connect();
        const ctx = makeLifeCtx();
        await getLifeHandler(lastBotInstance)(ctx);
        expect(ctx.reply).not.toHaveBeenCalled();
      }

      const groupOpts = admittedOpts();
      const groupCh = new TelegramChannel('token123', groupOpts);
      await groupCh.connect();
      const groupCtx = makeLifeCtx({
        chat: { id: 111, type: 'group' },
      });
      await getLifeHandler(lastBotInstance)(groupCtx);
      expect(groupCtx.reply).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('makes no Life request for disallowed senders', async () => {
      setLifeEnv();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonRes({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
      );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx({ from: { id: 999, first_name: 'Intruder' } });
      await getLifeHandler(lastBotInstance)(ctx);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('rejects on authentication failure', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes({ success: false }, 401));
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('rejected'),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns unconfirmed on server failures', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes({ success: false }, 500));
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('unconfirmed'),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns unconfirmed on timeout without retry', async () => {
      setLifeEnv();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: any, init?: any) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        },
      );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      vi.useFakeTimers();
      try {
        const pending = getLifeHandler(lastBotInstance)(ctx);
        await vi.advanceTimersByTimeAsync(10000);
        await pending;
      } finally {
        vi.useRealTimers();
      }
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('unconfirmed'),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns unconfirmed on transport interruption', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('network down'));
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const ctx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('unconfirmed'),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('consumes explicit capture commands before pending-reply handling', async () => {
      setLifeEnv();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (url: any, _init?: any) => {
          const u = String(url);
          if (u.includes('/decisions/')) {
            return { ok: true } as Response;
          }
          return jsonRes(
            { success: true, data: { captureId: 'cap-1', entryId: 1 } },
            201,
          );
        },
      );
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const cbHandler = lastBotInstance.on.mock.calls.find(
        (c: any) => c[0] === 'callback_query:data',
      )?.[1];
      await cbHandler({
        callbackQuery: { data: 'decision:reject:dec-life-1' },
        chat: { id: 111 },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      });

      const lifeCtx = makeLifeCtx();
      await getLifeHandler(lastBotInstance)(lifeCtx);
      expect(fetchSpy.mock.calls.some((c: any) =>
        String(c[0]).includes('/text/captures'),
      )).toBe(true);
      expect(lifeCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Saved'),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
      // The command leaves the decision reply pending; consume it explicitly.
      await getTextHandler(lastBotInstance)({
        ...lifeCtx, message: { ...lifeCtx.message, text: 'skip' },
      });
      expect(fetchSpy.mock.calls.some((call) =>
        String(call[0]).includes('/decisions/dec-life-1'),
      )).toBe(true);
    });

    it('leaves ordinary text and voice dispatch intact', async () => {
      setLifeEnv();
      const audioText = 'fake-audio-bytes';
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          new TextEncoder().encode(audioText).buffer as ArrayBuffer,
      } as Response);
      const { forwardVoiceCapture } = await import('./life-voice-capture.js');
      vi.mocked(forwardVoiceCapture).mockResolvedValue({
        outcome: 'completed',
        captureId: 'cap-v',
      });

      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const textHandler = getTextHandler(lastBotInstance);
      const msgCtx = {
        message: { text: 'hello there', date: Date.now() / 1000, message_id: 5 },
        chat: { id: 111, type: 'private' },
        from: { id: 111, first_name: 'Ceo' },
        reply: vi.fn().mockResolvedValue(undefined),
        me: { username: 'test_bot' },
      };
      await textHandler(msgCtx);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);

      const voiceHandler = lastBotInstance.on.mock.calls.find(
        (c: any) => c[0] === 'message:voice',
      )?.[1];
      expect(voiceHandler).toBeDefined();
      await voiceHandler({
        chat: { id: 111, type: 'private' },
        message: {
          message_id: 333,
          date: Date.now() / 1000,
          voice: { file_id: 'f', file_size: 10, duration: 2, mime_type: 'audio/ogg' },
        },
        from: { id: 111, first_name: 'Ceo' },
        api: { getFile: vi.fn().mockResolvedValue({ file_path: 'v/file.ogg' }) },
      });
      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('life prompt delivery wiring', () => {
    const LIFE_ENV = {
      LIFE_API_URL: 'https://life.example.com',
      LIFE_JOURNAL_ID: 'journal-1',
      LIFE_API_TOKEN: 'test-token-abc',
    };

    function setLifeEnv() {
      process.env.LIFE_API_URL = LIFE_ENV.LIFE_API_URL;
      process.env.LIFE_JOURNAL_ID = LIFE_ENV.LIFE_JOURNAL_ID;
      process.env.LIFE_API_TOKEN = LIFE_ENV.LIFE_API_TOKEN;
    }

    function clearLifeEnv() {
      delete process.env.LIFE_API_URL;
      delete process.env.LIFE_JOURNAL_ID;
      delete process.env.LIFE_API_TOKEN;
    }

    function ceoOpts() {
      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      return opts;
    }

    beforeEach(() => {
      clearLifeEnv();
    });

    afterEach(() => {
      clearLifeEnv();
      vi.restoreAllMocks();
    });

    it('starts one consumer on polling connect and stops it on disconnect', async () => {
      setLifeEnv();
      const opts = ceoOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      expect(lifePromptConsumerRecords).toHaveLength(1);
      const record = lifePromptConsumerRecords[0];
      expect(record.start).toHaveBeenCalledTimes(1);
      expect(record.running).toBe(true);
      expect(ch.getLifePromptConsumer()).not.toBeNull();

      await ch.disconnect();
      expect(record.stop).toHaveBeenCalledTimes(1);
      expect(ch.getLifePromptConsumer()).toBeNull();
      expect(ch.isConnected()).toBe(false);
    });

    it('starts and stops the same consumer in webhook mode', async () => {
      setLifeEnv();
      const opts = ceoOpts();
      const ch = new TelegramChannel(
        'token123',
        opts,
        'https://example.com/telegram',
      );
      await ch.connect();

      expect(lifePromptConsumerRecords).toHaveLength(1);
      expect(lifePromptConsumerRecords[0].start).toHaveBeenCalledTimes(1);
      expect(ch.getLifePromptConsumer()).not.toBeNull();

      await ch.disconnect();
      expect(lifePromptConsumerRecords[0].stop).toHaveBeenCalledTimes(1);
      expect(ch.getLifePromptConsumer()).toBeNull();
      expect(ch.isConnected()).toBe(false);
    });

    it('passes live Life configuration and ceo routing through to the consumer', async () => {
      setLifeEnv();
      const opts = ceoOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();

      const deps = lifePromptConsumerRecords[0].deps;
      expect(deps.configProvider()).toEqual({
        baseUrl: 'https://life.example.com',
        journalId: 'journal-1',
        token: 'test-token-abc',
      });
      expect(deps.groupsProvider()).toEqual(
        expect.objectContaining({ 'tg:111': expect.objectContaining({ folder: 'ceo' }) }),
      );

      const bot = deps.botProvider();
      expect(bot).not.toBeNull();
      await expect(bot.getChatType('111')).resolves.toBe('private');
      await expect(bot.sendText('111', 'hello')).resolves.toBe(601);
      expect(lastBotInstance.api.sendMessage).toHaveBeenCalledWith('111', 'hello');

      await ch.disconnect();
    });

    it('provides no bot before connect and none after disconnect', async () => {
      setLifeEnv();
      const opts = ceoOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const deps = lifePromptConsumerRecords[0].deps;
      expect(deps.botProvider()).not.toBeNull();
      await ch.disconnect();
      expect(deps.botProvider()).toBeNull();
    });

    it('replaces the consumer on reconnection without leaking the previous one', async () => {
      setLifeEnv();
      const opts = ceoOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const first = lifePromptConsumerRecords[0];
      await ch.disconnect();
      await ch.connect();
      expect(lifePromptConsumerRecords).toHaveLength(2);
      expect(first.stop).toHaveBeenCalledTimes(1);
      expect(lifePromptConsumerRecords[1].start).toHaveBeenCalledTimes(1);
      await ch.disconnect();
    });
  });

  describe('/lifeask archive question command (production handler + real forwarder)', () => {
    const LIFE_ENV = {
      LIFE_API_URL: 'https://life.example.com',
      LIFE_JOURNAL_ID: 'journal-1',
      LIFE_API_TOKEN: 'test-token-abc',
    };

    function getAskHandler(bot: any) {
      const call = bot.command.mock.calls.find((c: any) => c[0] === 'lifeask');
      return call?.[1];
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

    function setLifeEnv() {
      process.env.LIFE_API_URL = LIFE_ENV.LIFE_API_URL;
      process.env.LIFE_JOURNAL_ID = LIFE_ENV.LIFE_JOURNAL_ID;
      process.env.LIFE_API_TOKEN = LIFE_ENV.LIFE_API_TOKEN;
    }

    function clearLifeEnv() {
      delete process.env.LIFE_API_URL;
      delete process.env.LIFE_JOURNAL_ID;
      delete process.env.LIFE_API_TOKEN;
    }

    function jsonRes(body: unknown, status: number): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    function successBody(threadKey: string, answer: string, extra: Record<string, unknown> = {}) {
      return {
        success: true,
        data: {
          threadKey,
          turnId: 'turn-1',
          answer,
          generation: 'gen-1',
          entryCount: 2,
          replayed: false,
          ...extra,
        },
      };
    }

    function admittedOpts() {
      const opts = makeOpts();
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:111': { folder: 'ceo' } as any,
      });
      return opts;
    }

    beforeEach(() => {
      clearLifeEnv();
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      clearLifeEnv();
    });

    it('asks the canonical receiver and displays the validated answer as plain text', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes(successBody('telegram:111', 'The archive remembers.'), 201));
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
      const bodyJson = JSON.parse(
        String((fetchSpy.mock.calls[0][1] as RequestInit).body),
      );
      expect(bodyJson).toEqual({
        sourceThreadKey: 'telegram:111',
        sourceMessageKey: 'telegram:111:222',
        question: 'what happened?',
      });
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply).toHaveBeenCalledWith('The archive remembers.');
      expect(opts.onMessage).not.toHaveBeenCalled();
      await ch.disconnect();
    });

    it('submits follow-ups with one thread key and handles stored replay', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes(successBody('telegram:111', 'answer'), 201));
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const handler = getAskHandler(lastBotInstance);
      await handler(makeAskCtx({ match: 'first' }));
      await handler(
        makeAskCtx({
          match: 'second',
          message: {
            message_id: 223,
            date: Date.now() / 1000,
            text: '/lifeask second',
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
      await ch.disconnect();
      fetchSpy.mockRestore();

      const replaySpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          jsonRes(successBody('telegram:111', 'Stored.', { replayed: true }), 200),
        );
      const opts2 = admittedOpts();
      const ch2 = new TelegramChannel('token123', opts2);
      await ch2.connect();
      const rctx = makeAskCtx({ match: 'same' });
      await getAskHandler(lastBotInstance)(rctx);
      expect(replaySpy).toHaveBeenCalledTimes(1);
      expect(rctx.reply).toHaveBeenCalledWith('Stored.');
      await ch2.disconnect();
    });

    it('makes no Life request for admission refusals, invalid input, or missing config', async () => {
      setLifeEnv();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes(successBody('telegram:111', 'a'), 201));
      const unregistered = makeOpts();
      (unregistered.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({});
      const chU = new TelegramChannel('token123', unregistered);
      await chU.connect();
      const uctx = makeAskCtx();
      await getAskHandler(lastBotInstance)(uctx);
      expect(uctx.reply).not.toHaveBeenCalled();
      await chU.disconnect();

      const groupOpts = admittedOpts();
      const chG = new TelegramChannel('token123', groupOpts);
      await chG.connect();
      const gctx = makeAskCtx({ chat: { id: 111, type: 'group' } });
      await getAskHandler(lastBotInstance)(gctx);
      expect(gctx.reply).not.toHaveBeenCalled();
      await chG.disconnect();

      const senderOpts = admittedOpts();
      const chS = new TelegramChannel('token123', senderOpts);
      await chS.connect();
      const sctx = makeAskCtx({ from: { id: 999 } });
      await getAskHandler(lastBotInstance)(sctx);
      expect(sctx.reply).not.toHaveBeenCalled();
      await chS.disconnect();

      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const blank = makeAskCtx({ match: '   ' });
      await getAskHandler(lastBotInstance)(blank);
      expect(blank.reply).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      await ch.disconnect();

      clearLifeEnv();
      const fetchSpy2 = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes(successBody('telegram:111', 'a'), 201));
      const opts2 = admittedOpts();
      const ch2 = new TelegramChannel('token123', opts2);
      await ch2.connect();
      const mctx = makeAskCtx();
      await getAskHandler(lastBotInstance)(mctx);
      expect(fetchSpy2).not.toHaveBeenCalled();
      expect(mctx.reply).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
      await ch2.disconnect();
    });

    it('never surfaces failures as answers and splits long answers in order', async () => {
      setLifeEnv();
      const failSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes({ success: false }, 401));
      const opts = admittedOpts();
      const ch = new TelegramChannel('token123', opts);
      await ch.connect();
      const fctx = makeAskCtx();
      await getAskHandler(lastBotInstance)(fctx);
      expect(fctx.reply).toHaveBeenCalledWith(expect.stringContaining('rejected'));
      await ch.disconnect();
      failSpy.mockRestore();

      setLifeEnv();
      const longAnswer = 'x'.repeat(4096) + 'y'.repeat(50) + 'END';
      const longSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonRes(successBody('telegram:111', longAnswer), 201));
      const opts2 = admittedOpts();
      const ch2 = new TelegramChannel('token123', opts2);
      await ch2.connect();
      const lctx = makeAskCtx();
      await getAskHandler(lastBotInstance)(lctx);
      expect(lctx.reply).toHaveBeenCalledTimes(2);
      expect(String(lctx.reply.mock.calls[0][0]).length).toBe(4096);
      expect(String(lctx.reply.mock.calls[0][0]) + String(lctx.reply.mock.calls[1][0])).toBe(
        longAnswer,
      );
      await ch2.disconnect();
      longSpy.mockRestore();
    });
  });
});
