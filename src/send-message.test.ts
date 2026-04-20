/**
 * Integration tests for POST /api/v1/messages/send endpoint.
 *
 * This file doubles as a contract document: downstream tasks can import the
 * exported constants to stay in sync with the endpoint's payload shape, auth
 * model, retry semantics, and rate-limit configuration.
 *
 * @module send-message-contract
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import path from 'path';

import { _initTestDatabase, _setMigrationsDir } from './db/index.js';
import { getOutboundMessage, countRecentMessages, insertOutboundMessage } from './db/index.js';
import {
  startMessageApi,
  stopMessageApi,
  _validateSendRequest,
  _RATE_LIMIT_MAX,
  _RATE_LIMIT_WINDOW_MS,
  _VALID_PARSE_MODES,
} from './message-api.js';
import type { SendRequest, ParseMode } from './message-api.js';

// ---------------------------------------------------------------------------
// Contract constants — importable by downstream tasks
// ---------------------------------------------------------------------------

/** Endpoint path for direct message sending. */
export const SEND_ENDPOINT = '/api/v1/messages/send' as const;

/** HTTP method for the send endpoint. */
export const SEND_METHOD = 'POST' as const;

/** Required payload shape for the send endpoint. */
export interface SendMessagePayload {
  chatId: string;
  text: string;
  parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
}

/** Successful response shape. */
export interface SendMessageSuccessResponse {
  id: string;
  status: 'sent';
}

/** Failed response shape (delivery error). */
export interface SendMessageFailureResponse {
  id: string;
  status: 'failed';
  error: string;
}

/** Auth model: localhost-only binding, no API key/JWT required. */
export const AUTH_MODEL = 'localhost-bind' as const;

/** Rate limit: max messages per recipient per window. */
export const RATE_LIMIT_MAX = _RATE_LIMIT_MAX;

/** Rate limit window in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = _RATE_LIMIT_WINDOW_MS;

/** Allowed parseMode values. */
export const VALID_PARSE_MODES = _VALID_PARSE_MODES;

/** Delivery mode: synchronous (awaits channel.sendMessage). */
export const DELIVERY_MODE = 'synchronous' as const;

/**
 * Retry semantics for the /send endpoint:
 * - No automatic retries (synchronous delivery returns immediately)
 * - Caller receives 502 on failure and is responsible for retrying
 * - Unlike POST /api/v1/messages which retries up to 3 times async
 */
export const RETRY_SEMANTICS = {
  automatic: false,
  maxRetries: 0,
  callerRetryResponsibility: true,
} as const;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

let nextPort = 15000;
function getPort(): number {
  return nextPort++;
}

function makeRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ statusCode: res.statusCode!, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/messages/send', () => {
  beforeEach(() => {
    _setMigrationsDir(MIGRATIONS_DIR);
    _initTestDatabase();
  });

  // -------------------------------------------------------------------------
  // Payload shape validation
  // -------------------------------------------------------------------------

  describe('payload shape validation', () => {
    it('rejects non-object body', () => {
      const result = _validateSendRequest('string');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('JSON object');
    });

    it('rejects null body', () => {
      const result = _validateSendRequest(null);
      expect(result.ok).toBe(false);
    });

    it('rejects missing chatId', () => {
      const result = _validateSendRequest({ text: 'hello' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('chatId');
    });

    it('rejects non-string chatId', () => {
      const result = _validateSendRequest({ chatId: 123, text: 'hello' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('chatId');
    });

    it('rejects empty chatId', () => {
      const result = _validateSendRequest({ chatId: '', text: 'hello' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('chatId');
    });

    it('rejects missing text', () => {
      const result = _validateSendRequest({ chatId: 'tg:123' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('text');
    });

    it('rejects non-string text', () => {
      const result = _validateSendRequest({ chatId: 'tg:123', text: 42 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('text');
    });

    it('rejects empty text', () => {
      const result = _validateSendRequest({ chatId: 'tg:123', text: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('text');
    });

    it('rejects invalid parseMode', () => {
      const result = _validateSendRequest({
        chatId: 'tg:123',
        text: 'hello',
        parseMode: 'invalid',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('parseMode');
    });

    it('accepts minimal valid payload {chatId, text}', () => {
      const result = _validateSendRequest({
        chatId: 'tg:123',
        text: 'hello',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({
          chatId: 'tg:123',
          text: 'hello',
          parseMode: undefined,
        });
      }
    });

    it('accepts full payload {chatId, text, parseMode}', () => {
      const result = _validateSendRequest({
        chatId: 'tg:123',
        text: 'hello',
        parseMode: 'MarkdownV2',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.parseMode).toBe('MarkdownV2');
      }
    });

    it('accepts all valid parseMode values', () => {
      for (const mode of VALID_PARSE_MODES) {
        const result = _validateSendRequest({
          chatId: 'tg:123',
          text: 'hello',
          parseMode: mode,
        });
        expect(result.ok).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // HTTP integration (auth, delivery, status codes)
  // -------------------------------------------------------------------------

  describe('HTTP integration', () => {
    let testPort: number;

    const mockChannel = {
      name: 'test',
      connect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
      ownsJid: (jid: string) => jid.startsWith('tg:'),
      disconnect: vi.fn(),
    };

    beforeEach(async () => {
      testPort = getPort();
      mockChannel.sendMessage.mockClear();
      mockChannel.sendMessage.mockResolvedValue(undefined);
      await startMessageApi(() => [mockChannel], testPort);
    });

    afterEach(async () => {
      await stopMessageApi();
    });

    // --- Auth ---

    it('is accessible on localhost without API key or auth headers', async () => {
      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'Auth test',
      });
      // Should not return 401 or 403 — localhost-only auth model
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
      expect(res.statusCode).toBe(200);
    });

    // --- Successful delivery ---

    it('returns 200 with {id, status: "sent"} on successful delivery', async () => {
      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'Hello from send',
      });

      expect(res.statusCode).toBe(200);
      const body = res.body as SendMessageSuccessResponse;
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe('string');
      expect(body.status).toBe('sent');
    });

    it('calls channel.sendMessage with correct chatId and text', async () => {
      await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'Direct send test',
      });

      expect(mockChannel.sendMessage).toHaveBeenCalledOnce();
      expect(mockChannel.sendMessage).toHaveBeenCalledWith(
        'tg:12345',
        'Direct send test',
      );
    });

    it('records sent message in outbound_messages table', async () => {
      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'Audit trail test',
      });

      const body = res.body as { id: string };
      const msg = getOutboundMessage(body.id);
      expect(msg).toBeDefined();
      expect(msg!.recipient_id).toBe('tg:12345');
      expect(msg!.content).toBe('Audit trail test');
      expect(msg!.status).toBe('sent');
      expect(msg!.sent_at).toBeDefined();
    });

    // --- Validation errors ---

    it('returns 400 for missing chatId', async () => {
      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        text: 'No chatId',
      });
      expect(res.statusCode).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain('chatId');
    });

    it('returns 400 for missing text', async () => {
      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
      });
      expect(res.statusCode).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain('text');
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await new Promise<{ statusCode: number; body: unknown }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: testPort,
              path: SEND_ENDPOINT,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
            (resp) => {
              const chunks: Buffer[] = [];
              resp.on('data', (chunk) => chunks.push(chunk));
              resp.on('end', () => {
                resolve({
                  statusCode: resp.statusCode!,
                  body: JSON.parse(Buffer.concat(chunks).toString()),
                });
              });
            },
          );
          req.on('error', reject);
          req.write('not json');
          req.end();
        },
      );

      expect(res.statusCode).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain('Invalid JSON');
    });

    it('returns 400 for invalid parseMode', async () => {
      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'hello',
        parseMode: 'plaintext',
      });
      expect(res.statusCode).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain('parseMode');
    });

    // --- Delivery failure ---

    it('returns 502 when channel delivery fails', async () => {
      mockChannel.sendMessage.mockRejectedValueOnce(
        new Error('Telegram API timeout'),
      );

      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'Will fail',
      });

      expect(res.statusCode).toBe(502);
      const body = res.body as SendMessageFailureResponse;
      expect(body.status).toBe('failed');
      expect(body.error).toContain('Telegram API timeout');
      expect(body.id).toBeDefined();
    });

    it('records failed status in DB on delivery error', async () => {
      mockChannel.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'Will fail',
      });

      const body = res.body as { id: string };
      const msg = getOutboundMessage(body.id);
      expect(msg).toBeDefined();
      expect(msg!.status).toBe('failed');
      expect(msg!.error_message).toContain('Network error');
    });

    it('returns 502 when no channel matches the chatId', async () => {
      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'unknown:999',
        text: 'No matching channel',
      });

      expect(res.statusCode).toBe(502);
      const body = res.body as { error: string };
      expect(body.error).toContain('No connected channel');
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe('rate limiting', () => {
    let testPort: number;

    const mockChannel = {
      name: 'test',
      connect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
      ownsJid: (jid: string) => jid.startsWith('tg:'),
      disconnect: vi.fn(),
    };

    beforeEach(async () => {
      testPort = getPort();
      mockChannel.sendMessage.mockClear();
      await startMessageApi(() => [mockChannel], testPort);
    });

    afterEach(async () => {
      await stopMessageApi();
    });

    it('returns 429 when rate limit is exceeded for a recipient', async () => {
      // Seed the DB with RATE_LIMIT_MAX messages for the recipient
      const now = new Date().toISOString();
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        insertOutboundMessage({
          id: `rl-send-${i}`,
          recipient_id: 'tg:rate-limited',
          recipient_type: 'channel_jid',
          template: 'custom',
          content: `Msg ${i}`,
          priority: 'normal',
          status: 'sent',
          scheduled_for: null,
          batch_key: null,
          batch_window: 0,
          created_at: now,
        });
      }

      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:rate-limited',
        text: 'Over the limit',
      });

      expect(res.statusCode).toBe(429);
      const body = res.body as { error: string };
      expect(body.error).toContain('Rate limit exceeded');
    });

    it('allows sending to a different recipient even when one is rate-limited', async () => {
      const now = new Date().toISOString();
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        insertOutboundMessage({
          id: `rl-other-${i}`,
          recipient_id: 'tg:limited-chat',
          recipient_type: 'channel_jid',
          template: 'custom',
          content: `Msg ${i}`,
          priority: 'normal',
          status: 'sent',
          scheduled_for: null,
          batch_key: null,
          batch_window: 0,
          created_at: now,
        });
      }

      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:different-chat',
        text: 'Not rate limited',
      });

      expect(res.statusCode).toBe(200);
    });

    it('shares rate limit window with POST /api/v1/messages', async () => {
      // Messages sent via the messages endpoint count against the send endpoint's limit
      const now = new Date().toISOString();
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        insertOutboundMessage({
          id: `rl-shared-${i}`,
          recipient_id: 'tg:shared-limit',
          recipient_type: 'channel_jid',
          template: 'custom',
          content: `Msg ${i}`,
          priority: 'normal',
          status: 'pending',
          scheduled_for: null,
          batch_key: null,
          batch_window: 0,
          created_at: now,
        });
      }

      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:shared-limit',
        text: 'Over shared limit',
      });

      expect(res.statusCode).toBe(429);
    });
  });

  // -------------------------------------------------------------------------
  // Retry semantics
  // -------------------------------------------------------------------------

  describe('retry semantics', () => {
    let testPort: number;

    const mockChannel = {
      name: 'test',
      connect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: () => true,
      ownsJid: (jid: string) => jid.startsWith('tg:'),
      disconnect: vi.fn(),
    };

    beforeEach(async () => {
      testPort = getPort();
      mockChannel.sendMessage.mockClear();
      await startMessageApi(() => [mockChannel], testPort);
    });

    afterEach(async () => {
      await stopMessageApi();
    });

    it('does not retry on delivery failure (synchronous, single attempt)', async () => {
      mockChannel.sendMessage.mockRejectedValue(new Error('Delivery failed'));

      await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'Will fail',
      });

      // Should call sendMessage exactly once — no automatic retries
      expect(mockChannel.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('reports failure immediately without retry delay', async () => {
      mockChannel.sendMessage.mockRejectedValue(new Error('Instant fail'));

      const start = Date.now();
      const res = await makeRequest(testPort, 'POST', SEND_ENDPOINT, {
        chatId: 'tg:12345',
        text: 'Will fail fast',
      });
      const elapsed = Date.now() - start;

      expect(res.statusCode).toBe(502);
      // Should respond quickly (no retry backoff delays)
      expect(elapsed).toBeLessThan(2000);
    });
  });

  // -------------------------------------------------------------------------
  // Contract constants verification
  // -------------------------------------------------------------------------

  describe('contract constants', () => {
    it('endpoint path matches implementation', () => {
      expect(SEND_ENDPOINT).toBe('/api/v1/messages/send');
    });

    it('method is POST', () => {
      expect(SEND_METHOD).toBe('POST');
    });

    it('auth model is localhost-bind', () => {
      expect(AUTH_MODEL).toBe('localhost-bind');
    });

    it('delivery mode is synchronous', () => {
      expect(DELIVERY_MODE).toBe('synchronous');
    });

    it('retry semantics indicate no automatic retries', () => {
      expect(RETRY_SEMANTICS.automatic).toBe(false);
      expect(RETRY_SEMANTICS.maxRetries).toBe(0);
      expect(RETRY_SEMANTICS.callerRetryResponsibility).toBe(true);
    });

    it('rate limit constants are configured', () => {
      expect(RATE_LIMIT_MAX).toBeGreaterThan(0);
      expect(RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
    });

    it('valid parse modes match Telegram API', () => {
      expect(VALID_PARSE_MODES).toContain('MarkdownV2');
      expect(VALID_PARSE_MODES).toContain('HTML');
      expect(VALID_PARSE_MODES).toContain('Markdown');
    });
  });
});
