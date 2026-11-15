import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ToolCallEvent } from '../db/tool-events.js';
import { TelegramChannel } from './telegram.js';
import type { TelegramChannelOpts } from './telegram.js';

vi.mock('../db/tool-events.js', () => ({
  getRecentToolEvents: vi.fn(() => []),
}));

vi.mock('./life-voice-capture.js', () => ({
  forwardVoiceCapture: vi.fn(async () => ({ outcome: 'completed' })),
}));

// Track all created bot instances for assertions
let lastBotInstance: any = null;

vi.mock('grammy', () => {
  const setLastBotInstance = (bot: unknown) => {
    lastBotInstance = bot;
  };

  class MockBot {
    api = {
      sendMessage: vi.fn().mockResolvedValue({}),
      sendChatAction: vi.fn().mockResolvedValue(true),
      setWebhook: vi.fn().mockResolvedValue(true),
      deleteWebhook: vi.fn().mockResolvedValue(true),
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
});
