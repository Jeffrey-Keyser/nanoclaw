import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forwardVoiceCapture } from './life-voice-capture.js';
import type { LifeVoiceFetch } from './life-voice-capture.js';
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
const AUDIO_TEXT = 'AUDIO-BYTES-xyz-123-unique';
const FILE_URL = 'https://api.telegram.org/file/botABC/voice/file_123.ogg';
const BASE_URL = 'https://life.example.com';
const JOURNAL_ID = '42';
const SOURCE_KEY = 'telegram:111:222';

const CAP_NEW = '11111111-1111-4111-8111-111111111111';
const CAP_REPLAY = '22222222-2222-4222-8222-222222222222';
const CAP_DONE = '33333333-3333-4333-8333-333333333333';
const CAP_RESOLVE = '44444444-4444-4434-8434-444444444444';
const CAP_WAIT = '55555555-5555-4535-8535-555555555555';
const CAP_FAILED = '66666666-6666-4636-8636-666666666666';
const CAP_UNRESOLVED = '77777777-7777-4737-8737-777777777777';
const CAP_BAD = '88888888-8888-4838-8838-888888888888';

function audioBytes(): Uint8Array {
  return new TextEncoder().encode(AUDIO_TEXT);
}

function config() {
  return { baseUrl: BASE_URL, journalId: JOURNAL_ID, token: SECRET_TOKEN };
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

function expectNoSecrets() {
  const text = loggedText();
  expect(text).not.toContain(SECRET_TOKEN);
  expect(text).not.toContain(AUDIO_TEXT);
  expect(text).not.toContain(FILE_URL);
  expect(text).not.toContain('api.telegram.org');
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): {
  fetchImpl: LifeVoiceFetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: LifeVoiceFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

async function readFormField(body: unknown, name: string): Promise<unknown> {
  if (body instanceof FormData) return body.get(name);
  throw new Error('expected FormData body');
}

function receiptUrl(): string {
  return `${BASE_URL}/api/v1/journals/${JOURNAL_ID}/voice/captures`;
}

describe('forwardVoiceCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads multipart audio with bearer auth then processes and completes for a new receipt', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      durationSeconds: 12,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_NEW });
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);

    const receipt = calls[0];
    expect(receipt.url).toBe(receiptUrl());
    expect(receipt.url).toContain('/api/v1/journals/42/voice/captures');
    const headers = receipt.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    const sourceValue = await readFormField(
      receipt.init?.body,
      'sourceMessageKey',
    );
    expect(sourceValue).toBe(SOURCE_KEY);
    const audioPart = (await readFormField(
      receipt.init?.body,
      'audio',
    )) as Blob;
    expect(audioPart).toBeInstanceOf(Blob);
    expect(audioPart.type).toBe('audio/ogg');
    expect(await audioPart.text()).toBe(AUDIO_TEXT);
    for (const call of calls.slice(1)) {
      const h = call.init?.headers as Record<string, string>;
      expect(h['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    }
    expectNoSecrets();
  });

  it('processes an unfinished replayed receipt through to completion', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_REPLAY, state: 'unfinished', replayed: true },
          },
          200,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_REPLAY, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_REPLAY, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_REPLAY });
    expect(calls).toHaveLength(3);
    expectNoSecrets();
  });

  it('returns completed immediately for an already completed receipt without further mutation', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_DONE, state: 'completed', replayed: true },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_DONE });
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('returns review_in_life for a resolve nextAction without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_RESOLVE, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_RESOLVE, state: 'unresolved', nextAction: 'resolve' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'review_in_life', captureId: CAP_RESOLVE });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('carries owner-review indication for review_ready with resolve without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_RESOLVE, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_RESOLVE, state: 'review_ready', nextAction: 'resolve' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({
      outcome: 'review_in_life',
      captureId: CAP_RESOLVE,
      needsOwnerReview: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('carries no owner-review indication when review_ready has another action', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_RESOLVE, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_RESOLVE, state: 'review_ready', nextAction: 'wait' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'review_in_life', captureId: CAP_RESOLVE });
    expect(calls).toHaveLength(2);
    expectNoSecrets();
  });

  it('carries no owner-review indication when resolve has another state', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_RESOLVE, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_RESOLVE, state: 'unfinished', nextAction: 'resolve' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'review_in_life', captureId: CAP_RESOLVE });
    expectNoSecrets();
  });

  it('returns review_in_life for a wait nextAction without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_WAIT, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_WAIT, state: 'unfinished', nextAction: 'wait' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/mpeg',
      sourceMessageKey: SOURCE_KEY,
      durationSeconds: 5,
    });

    expect(result).toEqual({ outcome: 'review_in_life', captureId: CAP_WAIT });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('returns review_in_life for an unresolved receipt without invoking process', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_UNRESOLVED, state: 'unresolved' } },
          201,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'review_in_life', captureId: CAP_UNRESOLVED });
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('returns failed for an explicit capture failure state', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_FAILED, state: 'failed', code: 'transcription_failed' },
          },
          201,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.captureId).toBe(CAP_FAILED);
    expect(result.code).toBe('transcription_failed');
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('returns failed with Life code on receipt 4xx without throwing', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse({ success: false, code: 'invalid_audio' }, 422);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'failed', code: 'invalid_audio' });
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('returns failed on receipt 5xx without throwing', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse({ success: false, code: 'internal_error' }, 500);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('internal_error');
    expectNoSecrets();
  });

  it('returns failed on process redeliver without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_BAD, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_BAD, state: 'unfinished', nextAction: 'redeliver', code: 'retry_later' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({
      outcome: 'failed',
      captureId: CAP_BAD,
      code: 'retry_later',
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expectNoSecrets();
  });

  it('returns failed on process 5xx without throwing', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_BAD, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse({ success: false, code: 'process_down' }, 503);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('process_down');
    expectNoSecrets();
  });

  it('returns failed when fetch throws without throwing', async () => {
    const fetchImpl: LifeVoiceFetch = async () => {
      throw new Error('network down');
    };

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(typeof result.code).toBe('string');
    expectNoSecrets();
  });

  it('returns failed on malformed success envelopes without reporting completed', async () => {
    for (const malformed of [
      { success: true },
      { success: true, data: null },
      { success: true, data: { state: 'unfinished' } },
      { ok: true, data: { captureId: CAP_BAD, state: 'unfinished' } },
    ]) {
      const { fetchImpl } = recordingFetch((url) => {
        if (url === receiptUrl()) {
          return jsonResponse(malformed, 201);
        }
        throw new Error(`unexpected url ${url}`);
      });
      const result = await forwardVoiceCapture({
        fetchImpl,
        config: config(),
        audio: audioBytes(),
        mimeType: 'audio/ogg',
        sourceMessageKey: SOURCE_KEY,
      });
      expect(result.outcome).toBe('failed');
    }
    expectNoSecrets();
  });

  it('returns failed when completion capture identity does not match', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_BAD, state: 'completed' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('completion_mismatch');
    expectNoSecrets();
  });

  it('returns failed when completion state is not completed', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('completion_mismatch');
    expectNoSecrets();
  });

  it('includes promptInstanceId on the initial receipt while preserving original audio', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      promptInstanceId: 'prompt-voice-1',
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_NEW });
    expect(calls).toHaveLength(3);
    const receiptBody = calls[0].init?.body;
    expect(receiptBody).toBeInstanceOf(FormData);
    const form = receiptBody as FormData;
    expect(form.get('promptInstanceId')).toBe('prompt-voice-1');
    expect(form.get('sourceMessageKey')).toBe(SOURCE_KEY);
    const audioPart = form.get('audio') as Blob;
    expect(audioPart).toBeInstanceOf(Blob);
    expect(await audioPart.text()).toBe(AUDIO_TEXT);
    expectNoSecrets();
  });

  it('omits promptInstanceId from the receipt when not supplied', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    const receiptBody = calls[0].init?.body;
    expect(receiptBody).toBeInstanceOf(FormData);
    expect((receiptBody as FormData).get('promptInstanceId')).toBeNull();
    expectNoSecrets();
  });

  it('never calls resolve', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    for (const call of calls) {
      expect(call.url).not.toContain('resolve');
    }
    expectNoSecrets();
  });

  it('retries the receipt once after a fetch rejection and completes a new capture', async () => {
    let receiptAttempts = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) throw new Error('network down');
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      durationSeconds: 12,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_NEW });
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(receiptUrl());
    expect(calls[1].url).toBe(receiptUrl());
    expect(calls[2].url.endsWith('/process')).toBe(true);
    expect(calls[3].url.endsWith('/complete')).toBe(true);
    for (const call of calls.slice(0, 2)) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
      const body = call.init?.body as FormData;
      expect(body.get('sourceMessageKey')).toBe(SOURCE_KEY);
      expect(body.get('durationSeconds')).toBe('12');
      expect(await (body.get('audio') as Blob).text()).toBe(AUDIO_TEXT);
    }
    expectNoSecrets();
  });

  it('retries the receipt once and completes a replayed capture', async () => {
    let receiptAttempts = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) throw new Error('network down');
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_REPLAY, state: 'unfinished', replayed: true },
          },
          200,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_REPLAY, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_REPLAY, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      promptInstanceId: 'prompt-voice-1',
      durationSeconds: 7,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_REPLAY });
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(receiptUrl());
    expect(calls[1].url).toBe(receiptUrl());
    for (const call of calls.slice(0, 2)) {
      const body = call.init?.body as FormData;
      expect(body.get('sourceMessageKey')).toBe(SOURCE_KEY);
      expect(body.get('promptInstanceId')).toBe('prompt-voice-1');
      expect(body.get('durationSeconds')).toBe('7');
      expect(await (body.get('audio') as Blob).text()).toBe(AUDIO_TEXT);
      const headers = call.init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    }
    expectNoSecrets();
  });

  it('retries the receipt once and holds review without completing', async () => {
    let receiptAttempts = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) throw new Error('network down');
        return jsonResponse(
          { success: true, data: { captureId: CAP_RESOLVE, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_RESOLVE, state: 'review_ready', nextAction: 'resolve' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({
      outcome: 'review_in_life',
      captureId: CAP_RESOLVE,
      needsOwnerReview: true,
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(receiptUrl());
    expect(calls[1].url).toBe(receiptUrl());
    expect(calls[2].url.endsWith('/process')).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expectNoSecrets();
  });

  it('ends forwarding when the retried receipt fetch also rejects', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) throw new Error('network down');
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({ outcome: 'failed', code: 'fetch_failed' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(receiptUrl());
    expect(calls[1].url).toBe(receiptUrl());
    expectNoSecrets();
  });

  it('does not retry an HTTP error receipt response', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse({ success: false, code: 'invalid_audio' }, 422);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({ outcome: 'failed', code: 'invalid_audio' });
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('retains a single receipt attempt without opt-in', async () => {
    let receiptAttempts = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        receiptAttempts += 1;
        throw new Error('network down');
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'failed', code: 'fetch_failed' });
    expect(receiptAttempts).toBe(1);
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('retries a 502 AUDIO_NOT_RETAINED redelivery once with identical receipt identity', async () => {
    let receiptAttempts = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) {
          return jsonResponse(
            {
              success: false,
              code: 'AUDIO_NOT_RETAINED',
              nextAction: 'redeliver',
            },
            502,
          );
        }
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      durationSeconds: 12,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_NEW });
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(receiptUrl());
    expect(calls[1].url).toBe(receiptUrl());
    for (const call of calls.slice(0, 2)) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
      const body = call.init?.body as FormData;
      expect(body.get('sourceMessageKey')).toBe(SOURCE_KEY);
      expect(body.get('durationSeconds')).toBe('12');
      expect(await (body.get('audio') as Blob).text()).toBe(AUDIO_TEXT);
    }
    expectNoSecrets();
  });

  it('retries a 503 RECEIPT_NOT_PERSISTED redelivery once and completes a replayed capture', async () => {
    let receiptAttempts = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) {
          return jsonResponse(
            {
              success: false,
              data: { code: 'RECEIPT_NOT_PERSISTED', nextAction: 'redeliver' },
            },
            503,
          );
        }
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_REPLAY, state: 'unfinished', replayed: true },
          },
          200,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_REPLAY, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_REPLAY, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      promptInstanceId: 'prompt-voice-1',
      durationSeconds: 7,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_REPLAY });
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(receiptUrl());
    expect(calls[1].url).toBe(receiptUrl());
    for (const call of calls.slice(0, 2)) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
      const body = call.init?.body as FormData;
      expect(body.get('sourceMessageKey')).toBe(SOURCE_KEY);
      expect(body.get('promptInstanceId')).toBe('prompt-voice-1');
      expect(body.get('durationSeconds')).toBe('7');
      expect(await (body.get('audio') as Blob).text()).toBe(AUDIO_TEXT);
    }
    expectNoSecrets();
  });

  it('holds review without completing after a redelivered receipt', async () => {
    let receiptAttempts = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) {
          return jsonResponse(
            {
              success: false,
              code: 'AUDIO_NOT_RETAINED',
              nextAction: 'redeliver',
            },
            502,
          );
        }
        return jsonResponse(
          { success: true, data: { captureId: CAP_RESOLVE, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_RESOLVE, state: 'review_ready', nextAction: 'resolve' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({
      outcome: 'review_in_life',
      captureId: CAP_RESOLVE,
      needsOwnerReview: true,
    });
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expectNoSecrets();
  });

  it('returns completed without further mutation for an already completed replay after redelivery', async () => {
    let receiptAttempts = 0;
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) {
          return jsonResponse(
            {
              success: false,
              code: 'RECEIPT_NOT_PERSISTED',
              nextAction: 'redeliver',
            },
            503,
          );
        }
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_DONE, state: 'completed', replayed: true },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      retryReceiptOnFetchFailure: true,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_DONE });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.url === receiptUrl())).toBe(true);
    expectNoSecrets();
  });

  it('enforces one owner receipt retry across transport and explicit redelivery failures', async () => {
    async function runReceiptSequence(
      responses: Array<{ kind: 'throw' } | { kind: 'response'; body: unknown; status: number }>,
      withOptIn: boolean,
    ): Promise<{ result: { outcome: string; code?: string; captureId?: string }; calls: Array<{ url: string; init?: RequestInit }> }> {
      let index = 0;
      const { fetchImpl, calls } = recordingFetch((url) => {
        if (url === receiptUrl()) {
          const step = responses[Math.min(index, responses.length - 1)];
          index += 1;
          if (step.kind === 'throw') throw new Error('network down');
          return jsonResponse(step.body, step.status);
        }
        if (url.endsWith('/process')) {
          return jsonResponse(
            {
              success: true,
              data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
            },
            200,
          );
        }
        if (url.endsWith('/complete')) {
          return jsonResponse(
            { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
            200,
          );
        }
        throw new Error(`unexpected url ${url}`);
      });
      const result = await forwardVoiceCapture({
        fetchImpl,
        config: config(),
        audio: audioBytes(),
        mimeType: 'audio/ogg',
        sourceMessageKey: SOURCE_KEY,
        ...(withOptIn ? { retryReceiptOnFetchFailure: true as const } : {}),
      });
      return { result, calls };
    }

    const redeliver502 = {
      kind: 'response' as const,
      body: { success: false, code: 'AUDIO_NOT_RETAINED', nextAction: 'redeliver' },
      status: 502,
    };
    const redeliver503 = {
      kind: 'response' as const,
      body: { success: false, code: 'RECEIPT_NOT_PERSISTED', nextAction: 'redeliver' },
      status: 503,
    };

    const mixedThrowThenRedeliver = await runReceiptSequence(
      [{ kind: 'throw' }, redeliver502],
      true,
    );
    expect(mixedThrowThenRedeliver.result.outcome).toBe('failed');
    expect(mixedThrowThenRedeliver.result.code).toBe('AUDIO_NOT_RETAINED');
    expect(mixedThrowThenRedeliver.calls).toHaveLength(2);
    expect(mixedThrowThenRedeliver.calls.every((c) => c.url === receiptUrl())).toBe(true);

    const mixedRedeliverThenThrow = await runReceiptSequence(
      [redeliver503, { kind: 'throw' }],
      true,
    );
    expect(mixedRedeliverThenThrow.result).toEqual({
      outcome: 'failed',
      code: 'fetch_failed',
    });
    expect(mixedRedeliverThenThrow.calls).toHaveLength(2);

    const repeatedExplicit = await runReceiptSequence([redeliver502, redeliver502], true);
    expect(repeatedExplicit.result.outcome).toBe('failed');
    expect(repeatedExplicit.result.code).toBe('AUDIO_NOT_RETAINED');
    expect(repeatedExplicit.calls).toHaveLength(2);
    expect(repeatedExplicit.calls.every((c) => c.url === receiptUrl())).toBe(true);

    for (const unrelated of [
      { body: { success: false, code: 'invalid_audio' }, status: 422 },
      { body: { success: false, code: 'AUDIO_NOT_RETAINED', nextAction: 'redeliver' }, status: 500 },
      { body: { success: false, code: 'OTHER_CODE', nextAction: 'redeliver' }, status: 502 },
      { body: { success: false, code: 'AUDIO_NOT_RETAINED', nextAction: 'wait' }, status: 502 },
      { body: { success: false, code: 'AUDIO_NOT_RETAINED' }, status: 502 },
      { body: { success: false }, status: 502 },
      { body: { ok: true }, status: 502 },
    ]) {
      const outcome = await runReceiptSequence(
        [{ kind: 'response', body: unrelated.body, status: unrelated.status }],
        true,
      );
      expect(outcome.result.outcome).toBe('failed');
      expect(outcome.calls).toHaveLength(1);
      expect(outcome.calls[0].url).toBe(receiptUrl());
    }

    const withoutOptIn = await runReceiptSequence([redeliver502], false);
    expect(withoutOptIn.result.outcome).toBe('failed');
    expect(withoutOptIn.calls).toHaveLength(1);

    const withoutOptInThrow = await runReceiptSequence([{ kind: 'throw' }], false);
    expect(withoutOptInThrow.result).toEqual({ outcome: 'failed', code: 'fetch_failed' });
    expect(withoutOptInThrow.calls).toHaveLength(1);

    const terminal = await runReceiptSequence([redeliver502, redeliver503], true);
    expect(terminal.result.outcome).toBe('failed');
    expect(terminal.calls).toHaveLength(2);
    expect(terminal.calls.some((c) => c.url.endsWith('/process'))).toBe(false);
    expect(terminal.calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expectNoSecrets();
  });

  it('retries the same completion after a rejected fetch and accepts a new or replayed save', async () => {
    for (const replayed of [false, true]) {
      const captureId = replayed ? CAP_REPLAY : CAP_NEW;
      let completeAttempts = 0;
      const { fetchImpl, calls } = recordingFetch((url) => {
        if (url === receiptUrl()) {
          return jsonResponse(
            {
              success: true,
              data: {
                captureId,
                state: 'unfinished',
                ...(replayed ? { replayed: true } : {}),
              },
            },
            replayed ? 200 : 201,
          );
        }
        if (url.endsWith('/process')) {
          return jsonResponse(
            {
              success: true,
              data: { captureId, state: 'unfinished', nextAction: 'complete' },
            },
            200,
          );
        }
        if (url.endsWith('/complete')) {
          completeAttempts += 1;
          if (completeAttempts === 1) throw new Error('network down');
          return jsonResponse(
            {
              success: true,
              data: {
                captureId,
                state: 'completed',
                ...(replayed ? { replayed: true } : {}),
              },
            },
            200,
          );
        }
        throw new Error(`unexpected url ${url}`);
      });

      const result = await forwardVoiceCapture({
        fetchImpl,
        config: config(),
        audio: audioBytes(),
        mimeType: 'audio/ogg',
        sourceMessageKey: SOURCE_KEY,
        retryCompletionOnTransientFailure: true,
      });

      expect(result).toEqual({ outcome: 'completed', captureId });
      expect(calls).toHaveLength(4);
      expect(calls[0].url).toBe(receiptUrl());
      expect(calls[1].url.endsWith('/process')).toBe(true);
      expect(calls[2].url.endsWith('/complete')).toBe(true);
      expect(calls[3].url.endsWith('/complete')).toBe(true);
      expect(calls[2].url).toBe(calls[3].url);
      for (const call of calls.slice(2)) {
        const headers = call.init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
        expect(headers['Content-Type']).toBe('application/json');
        expect(call.init?.method).toBe('POST');
        expect(call.init?.body).toBe(JSON.stringify({}));
      }
      expect(calls.filter((c) => c.url === receiptUrl())).toHaveLength(1);
      expect(calls.filter((c) => c.url.endsWith('/process'))).toHaveLength(1);
      expect(calls.filter((c) => c.url.endsWith('/complete'))).toHaveLength(2);
    }
    expectNoSecrets();
  });

  it('allows one completion retry for the canonical failure and rejects other retry triggers', async () => {
    type CompleteStep =
      | { kind: 'throw' }
      | { kind: 'response'; body: unknown; status: number };

    async function runCompletionSequence(
      completeSteps: CompleteStep[],
      withOptIn: boolean,
    ): Promise<{
      result: { outcome: string; code?: string; captureId?: string };
      calls: Array<{ url: string; init?: RequestInit }>;
    }> {
      let index = 0;
      const { fetchImpl, calls } = recordingFetch((url) => {
        if (url === receiptUrl()) {
          return jsonResponse(
            { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
            201,
          );
        }
        if (url.endsWith('/process')) {
          return jsonResponse(
            {
              success: true,
              data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
            },
            200,
          );
        }
        if (url.endsWith('/complete')) {
          const step = completeSteps[Math.min(index, completeSteps.length - 1)];
          index += 1;
          if (step.kind === 'throw') throw new Error('network down');
          return jsonResponse(step.body, step.status);
        }
        throw new Error(`unexpected url ${url}`);
      });
      const result = await forwardVoiceCapture({
        fetchImpl,
        config: config(),
        audio: audioBytes(),
        mimeType: 'audio/ogg',
        sourceMessageKey: SOURCE_KEY,
        ...(withOptIn ? { retryCompletionOnTransientFailure: true as const } : {}),
      });
      return { result, calls };
    }

    const canonicalTop = {
      kind: 'response' as const,
      body: {
        success: false,
        error: 'completion failed, retry complete',
        code: 'COMPLETION_FAILED',
        nextAction: 'complete',
      },
      status: 503,
    };
    const canonicalNested = {
      kind: 'response' as const,
      body: {
        success: false,
        data: {
          error: 'completion failed, retry complete',
          code: 'COMPLETION_FAILED',
          nextAction: 'complete',
        },
      },
      status: 503,
    };
    const completedNew = {
      kind: 'response' as const,
      body: { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
      status: 200,
    };

    for (const canonical of [canonicalTop, canonicalNested]) {
      const retried = await runCompletionSequence([canonical, completedNew], true);
      expect(retried.result).toEqual({ outcome: 'completed', captureId: CAP_NEW });
      expect(retried.calls).toHaveLength(4);
      expect(retried.calls[0].url).toBe(receiptUrl());
      expect(retried.calls[1].url.endsWith('/process')).toBe(true);
      expect(retried.calls[2].url.endsWith('/complete')).toBe(true);
      expect(retried.calls[3].url.endsWith('/complete')).toBe(true);
      expect(retried.calls[2].url).toBe(retried.calls[3].url);
      for (const call of retried.calls.slice(2)) {
        const headers = call.init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
        expect(call.init?.body).toBe(JSON.stringify({}));
      }
    }

    const throwThenCanonical = await runCompletionSequence(
      [{ kind: 'throw' }, canonicalTop],
      true,
    );
    expect(throwThenCanonical.result.outcome).toBe('failed');
    expect(throwThenCanonical.result.code).toBe('COMPLETION_FAILED');
    expect(throwThenCanonical.calls).toHaveLength(4);
    expect(
      throwThenCanonical.calls.filter((c) => c.url.endsWith('/complete')),
    ).toHaveLength(2);

    const canonicalThenThrow = await runCompletionSequence(
      [canonicalTop, { kind: 'throw' }],
      true,
    );
    expect(canonicalThenThrow.result).toEqual({
      outcome: 'failed',
      captureId: CAP_NEW,
      code: 'fetch_failed',
    });
    expect(canonicalThenThrow.calls).toHaveLength(4);

    const canonicalThenCanonical = await runCompletionSequence(
      [canonicalTop, canonicalTop],
      true,
    );
    expect(canonicalThenCanonical.result.outcome).toBe('failed');
    expect(canonicalThenCanonical.result.code).toBe('COMPLETION_FAILED');
    expect(canonicalThenCanonical.calls).toHaveLength(4);
    expect(
      canonicalThenCanonical.calls.filter((c) => c.url.endsWith('/complete')),
    ).toHaveLength(2);

    for (const unrelated of [
      {
        body: {
          success: false,
          error: 'completion failed',
          code: 'COMPLETION_FAILED',
          nextAction: 'complete',
        },
        status: 500,
      },
      {
        body: {
          success: false,
          error: 'completion failed',
          code: 'COMPLETION_FAILED',
          nextAction: 'complete',
        },
        status: 502,
      },
      {
        body: {
          success: false,
          error: 'completion failed',
          code: 'COMPLETION_FAILED',
          nextAction: 'complete',
        },
        status: 422,
      },
      {
        body: {
          success: false,
          error: 'completion failed',
          code: 'OTHER_CODE',
          nextAction: 'complete',
        },
        status: 503,
      },
      {
        body: {
          success: false,
          error: 'completion failed',
          code: 'COMPLETION_FAILED',
          nextAction: 'wait',
        },
        status: 503,
      },
      {
        body: {
          success: false,
          code: 'COMPLETION_FAILED',
          nextAction: 'complete',
        },
        status: 503,
      },
      {
        body: {
          success: false,
          error: { code: 'COMPLETION_FAILED' },
          code: 'COMPLETION_FAILED',
          nextAction: 'complete',
        },
        status: 503,
      },
      { body: { success: false, code: 'invalid_audio' }, status: 422 },
      { body: { success: false, code: 'internal_error' }, status: 500 },
      { body: { success: true }, status: 200 },
      { body: { success: true, data: null }, status: 200 },
      {
        body: { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
        status: 200,
      },
      {
        body: { success: true, data: { captureId: CAP_BAD, state: 'completed' } },
        status: 200,
      },
    ]) {
      const outcome = await runCompletionSequence(
        [{ kind: 'response', body: unrelated.body, status: unrelated.status }],
        true,
      );
      expect(outcome.result.outcome).toBe('failed');
      expect(outcome.calls).toHaveLength(3);
      expect(outcome.calls[0].url).toBe(receiptUrl());
      expect(outcome.calls[1].url.endsWith('/process')).toBe(true);
      expect(outcome.calls[2].url.endsWith('/complete')).toBe(true);
    }

    const withoutOptInCanonical = await runCompletionSequence([canonicalTop], false);
    expect(withoutOptInCanonical.result.outcome).toBe('failed');
    expect(withoutOptInCanonical.calls).toHaveLength(3);

    const withoutOptInThrow = await runCompletionSequence([{ kind: 'throw' }], false);
    expect(withoutOptInThrow.result).toEqual({
      outcome: 'failed',
      captureId: CAP_NEW,
      code: 'fetch_failed',
    });
    expect(withoutOptInThrow.calls).toHaveLength(3);
    expectNoSecrets();
  });
});
