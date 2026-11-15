import { logger } from '../logger.js';

export interface LifeVoiceCaptureConfig {
  baseUrl: string;
  journalId: string;
  token: string;
}

export type LifeVoiceFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ForwardVoiceCaptureInput {
  fetchImpl: LifeVoiceFetch;
  config: LifeVoiceCaptureConfig;
  audio: Uint8Array | Buffer | ArrayBuffer | Blob;
  mimeType: string;
  sourceMessageKey: string;
  durationSeconds?: number;
}

export type ForwardVoiceCaptureOutcome =
  | 'completed'
  | 'review_in_life'
  | 'failed';

export interface ForwardVoiceCaptureResult {
  outcome: ForwardVoiceCaptureOutcome;
  captureId?: string;
  code?: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function extensionForMime(mimeType: string): string {
  const lower = mimeType.toLowerCase().split(';')[0].trim();
  if (lower === 'audio/ogg' || lower === 'audio/opus') return '.ogg';
  if (lower === 'audio/mpeg' || lower === 'audio/mp3') return '.mp3';
  if (lower === 'audio/mp4' || lower === 'audio/m4a') return '.m4a';
  if (lower === 'audio/webm') return '.webm';
  if (lower === 'audio/wav' || lower === 'audio/x-wav') return '.wav';
  return '.bin';
}

function toAudioBlob(
  audio: Uint8Array | Buffer | ArrayBuffer | Blob,
  mimeType: string,
): Blob {
  if (audio instanceof Blob) return audio;
  if (audio instanceof ArrayBuffer) {
    return new Blob([new Uint8Array(audio)], { type: mimeType });
  }
  return new Blob([audio as Uint8Array], { type: mimeType });
}

async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function errorCodeFromBody(
  body: Record<string, unknown>,
  status: number,
): string {
  const direct = body['code'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const nested = body['error'];
  if (typeof nested === 'string' && nested.length > 0) return nested;
  if (nested !== null && typeof nested === 'object') {
    const nestedCode = (nested as Record<string, unknown>)['code'];
    if (typeof nestedCode === 'string' && nestedCode.length > 0)
      return nestedCode;
  }
  const nextAction = body['nextAction'];
  if (typeof nextAction === 'string' && nextAction.length > 0)
    return nextAction;
  return `http_${status}`;
}

function captureIdFromBody(body: Record<string, unknown>): string | undefined {
  for (const key of ['captureId', 'id', 'capture_id']) {
    const value = body[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export async function forwardVoiceCapture(
  input: ForwardVoiceCaptureInput,
): Promise<ForwardVoiceCaptureResult> {
  const { fetchImpl, config, audio, mimeType, sourceMessageKey } = input;
  const durationSeconds = input.durationSeconds;
  const base = trimTrailingSlash(config.baseUrl);
  const journalSegment = encodeURIComponent(config.journalId);
  const receiptUrl = `${base}/api/v1/journals/${journalSegment}/voice-captures`;
  const authHeader = `Bearer ${config.token}`;

  try {
    const form = new FormData();
    form.append(
      'audio',
      toAudioBlob(audio, mimeType),
      `voice${extensionForMime(mimeType)}`,
    );
    form.append('sourceMessageKey', sourceMessageKey);
    if (
      typeof durationSeconds === 'number' &&
      Number.isFinite(durationSeconds)
    ) {
      form.append('durationSeconds', String(durationSeconds));
    }

    let receiptRes: Response;
    try {
      receiptRes = await fetchImpl(receiptUrl, {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: form,
      });
    } catch {
      logger.error(
        { sourceMessageKey, code: 'fetch_failed' },
        'Life voice receipt request failed',
      );
      return { outcome: 'failed', code: 'fetch_failed' };
    }

    const receiptBody = await readJsonBody(receiptRes);
    const replayed = receiptBody['replayed'] === true;
    const receiptOk =
      receiptRes.status === 201 || (receiptRes.status === 200 && replayed);
    if (!receiptOk) {
      const code = errorCodeFromBody(receiptBody, receiptRes.status);
      logger.warn(
        { sourceMessageKey, status: receiptRes.status, code },
        'Life voice receipt rejected',
      );
      return { outcome: 'failed', code };
    }

    const captureId = captureIdFromBody(receiptBody);
    if (!captureId) {
      logger.warn(
        {
          sourceMessageKey,
          status: receiptRes.status,
          code: 'missing_capture_id',
        },
        'Life voice receipt missing capture id',
      );
      return { outcome: 'failed', code: 'missing_capture_id' };
    }

    const processUrl = `${receiptUrl}/${encodeURIComponent(captureId)}/process`;
    let processRes: Response;
    try {
      processRes = await fetchImpl(processUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
    } catch {
      logger.error(
        { sourceMessageKey, captureId, code: 'fetch_failed' },
        'Life voice process request failed',
      );
      return { outcome: 'failed', captureId, code: 'fetch_failed' };
    }

    const processBody = await readJsonBody(processRes);
    if (!processRes.ok) {
      const code = errorCodeFromBody(processBody, processRes.status);
      logger.warn(
        { sourceMessageKey, captureId, status: processRes.status, code },
        'Life voice process rejected',
      );
      return { outcome: 'failed', captureId, code };
    }

    const nextAction =
      typeof processBody['nextAction'] === 'string'
        ? (processBody['nextAction'] as string)
        : '';
    if (nextAction === 'redeliver') {
      const code =
        typeof processBody['code'] === 'string' &&
        processBody['code'].length > 0
          ? (processBody['code'] as string)
          : 'redeliver';
      logger.warn(
        { sourceMessageKey, captureId, code, nextAction },
        'Life voice needs redelivery',
      );
      return { outcome: 'failed', captureId, code };
    }
    if (nextAction !== 'complete') {
      logger.info(
        { sourceMessageKey, captureId, nextAction },
        'Life voice held for review',
      );
      return { outcome: 'review_in_life', captureId };
    }

    const completeUrl = `${receiptUrl}/${encodeURIComponent(captureId)}/complete`;
    let completeRes: Response;
    try {
      completeRes = await fetchImpl(completeUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
    } catch {
      logger.error(
        { sourceMessageKey, captureId, code: 'fetch_failed' },
        'Life voice complete request failed',
      );
      return { outcome: 'failed', captureId, code: 'fetch_failed' };
    }

    if (!completeRes.ok) {
      const completeBody = await readJsonBody(completeRes);
      const code = errorCodeFromBody(completeBody, completeRes.status);
      logger.warn(
        { sourceMessageKey, captureId, status: completeRes.status, code },
        'Life voice complete rejected',
      );
      return { outcome: 'failed', captureId, code };
    }

    logger.info(
      { sourceMessageKey, captureId },
      'Life voice capture completed',
    );
    return { outcome: 'completed', captureId };
  } catch {
    logger.error(
      { sourceMessageKey, code: 'fetch_failed' },
      'Life voice forward failed',
    );
    return { outcome: 'failed', code: 'fetch_failed' };
  }
}
