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
  promptInstanceId?: string;
  durationSeconds?: number;
  onProcessDispatch?: () => void;
  retryReceiptOnFetchFailure?: boolean;
}

export type ForwardVoiceCaptureOutcome =
  | 'completed'
  | 'review_in_life'
  | 'failed';

export interface ForwardVoiceCaptureResult {
  outcome: ForwardVoiceCaptureOutcome;
  captureId?: string;
  code?: string;
  needsOwnerReview?: boolean;
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
  const data = body['data'];
  const sources: Record<string, unknown>[] = [body];
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    sources.push(data as Record<string, unknown>);
  }
  for (const source of sources) {
    const direct = source['code'];
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const nested = source['error'];
    if (typeof nested === 'string' && nested.length > 0) return nested;
    if (nested !== null && typeof nested === 'object') {
      const nestedCode = (nested as Record<string, unknown>)['code'];
      if (typeof nestedCode === 'string' && nestedCode.length > 0)
        return nestedCode;
    }
    const nextAction = source['nextAction'];
    if (typeof nextAction === 'string' && nextAction.length > 0)
      return nextAction;
  }
  return `http_${status}`;
}

function captureIdFromData(data: Record<string, unknown>): string | undefined {
  for (const key of ['captureId', 'id', 'capture_id']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readDataEnvelope(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (body['success'] !== true) return undefined;
  const data = body['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  return data as Record<string, unknown>;
}

function stateFromData(data: Record<string, unknown>): string | undefined {
  const state = data['state'];
  return typeof state === 'string' && state.length > 0 ? state : undefined;
}

function nextActionFromData(data: Record<string, unknown>): string {
  const nextAction = data['nextAction'];
  return typeof nextAction === 'string' ? nextAction : '';
}

function extractReceiptFailureCode(
  body: Record<string, unknown>,
): string | undefined {
  const data = body['data'];
  const sources: Record<string, unknown>[] = [body];
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    sources.push(data as Record<string, unknown>);
  }
  for (const source of sources) {
    const code = source['code'];
    if (typeof code === 'string' && code.length > 0) return code;
    const nestedError = source['error'];
    if (typeof nestedError === 'string' && nestedError.length > 0)
      return nestedError;
    if (
      nestedError !== null &&
      typeof nestedError === 'object' &&
      !Array.isArray(nestedError)
    ) {
      const nestedCode = (nestedError as Record<string, unknown>)['code'];
      if (typeof nestedCode === 'string' && nestedCode.length > 0)
        return nestedCode;
    }
  }
  return undefined;
}

function extractReceiptNextAction(
  body: Record<string, unknown>,
): string | undefined {
  const top = body['nextAction'];
  if (typeof top === 'string' && top.length > 0) return top;
  const data = body['data'];
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>)['nextAction'];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return undefined;
}

function isReceiptRedeliveryRequest(
  status: number,
  body: Record<string, unknown>,
): boolean {
  if (body['success'] !== false) return false;
  if (extractReceiptNextAction(body) !== 'redeliver') return false;
  const code = extractReceiptFailureCode(body);
  if (status === 502 && code === 'AUDIO_NOT_RETAINED') return true;
  if (status === 503 && code === 'RECEIPT_NOT_PERSISTED') return true;
  return false;
}

function codeFromData(data: Record<string, unknown>): string | undefined {
  const code = data['code'];
  if (typeof code === 'string' && code.length > 0) return code;
  const error = data['error'];
  if (typeof error === 'string' && error.length > 0) return error;
  return undefined;
}

export async function forwardVoiceCapture(
  input: ForwardVoiceCaptureInput,
): Promise<ForwardVoiceCaptureResult> {
  const { fetchImpl, config, audio, mimeType, sourceMessageKey } = input;
  const durationSeconds = input.durationSeconds;
  const promptInstanceId = input.promptInstanceId;
  const base = trimTrailingSlash(config.baseUrl);
  const journalSegment = encodeURIComponent(config.journalId);
  const receiptUrl = `${base}/api/v1/journals/${journalSegment}/voice/captures`;
  const authHeader = `Bearer ${config.token}`;

  try {
    const buildReceiptForm = (): FormData => {
      const form = new FormData();
      form.append(
        'audio',
        toAudioBlob(audio, mimeType),
        `voice${extensionForMime(mimeType)}`,
      );
      form.append('sourceMessageKey', sourceMessageKey);
      if (typeof promptInstanceId === 'string' && promptInstanceId.length > 0) {
        form.append('promptInstanceId', promptInstanceId);
      }
      if (
        typeof durationSeconds === 'number' &&
        Number.isFinite(durationSeconds)
      ) {
        form.append('durationSeconds', String(durationSeconds));
      }
      return form;
    };

    const postReceipt = (): Promise<Response> =>
      fetchImpl(receiptUrl, {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: buildReceiptForm(),
      });

    let receiptRes: Response | undefined;
    let receiptBody: Record<string, unknown> | undefined;
    let receiptRetryUsed = false;
    try {
      receiptRes = await postReceipt();
      receiptBody = await readJsonBody(receiptRes);
    } catch {
      if (input.retryReceiptOnFetchFailure !== true) {
        logger.error(
          { sourceMessageKey, code: 'fetch_failed' },
          'Life voice receipt request failed',
        );
        return { outcome: 'failed', code: 'fetch_failed' };
      }
      try {
        receiptRes = await postReceipt();
        receiptBody = await readJsonBody(receiptRes);
        receiptRetryUsed = true;
      } catch {
        logger.error(
          { sourceMessageKey, code: 'fetch_failed' },
          'Life voice receipt request failed',
        );
        return { outcome: 'failed', code: 'fetch_failed' };
      }
    }

    if (
      !receiptRetryUsed &&
      input.retryReceiptOnFetchFailure === true &&
      receiptRes !== undefined &&
      receiptBody !== undefined &&
      isReceiptRedeliveryRequest(receiptRes.status, receiptBody)
    ) {
      try {
        receiptRes = await postReceipt();
        receiptBody = await readJsonBody(receiptRes);
      } catch {
        logger.error(
          { sourceMessageKey, code: 'fetch_failed' },
          'Life voice receipt request failed',
        );
        return { outcome: 'failed', code: 'fetch_failed' };
      }
    }

    if (receiptRes === undefined || receiptBody === undefined) {
      logger.error(
        { sourceMessageKey, code: 'fetch_failed' },
        'Life voice receipt request failed',
      );
      return { outcome: 'failed', code: 'fetch_failed' };
    }
    if (!receiptRes.ok || receiptBody['success'] !== true) {
      const code = errorCodeFromBody(receiptBody, receiptRes.status);
      logger.warn(
        { sourceMessageKey, status: receiptRes.status, code },
        'Life voice receipt rejected',
      );
      return { outcome: 'failed', code };
    }

    const receiptData = readDataEnvelope(receiptBody);
    if (!receiptData) {
      logger.warn(
        {
          sourceMessageKey,
          status: receiptRes.status,
          code: 'malformed_envelope',
        },
        'Life voice receipt malformed envelope',
      );
      return { outcome: 'failed', code: 'malformed_envelope' };
    }

    const captureId = captureIdFromData(receiptData);
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

    const receiptState = stateFromData(receiptData);
    const replayed = receiptData['replayed'] === true;
    const receiptStatusOk =
      receiptRes.status === 201 ||
      (receiptRes.status === 200 && replayed === true);
    if (!receiptStatusOk) {
      logger.warn(
        {
          sourceMessageKey,
          status: receiptRes.status,
          code: 'unexpected_status',
        },
        'Life voice receipt unexpected status',
      );
      return { outcome: 'failed', captureId, code: 'unexpected_status' };
    }

    if (receiptState === 'completed') {
      logger.info(
        { sourceMessageKey, captureId },
        'Life voice capture already completed',
      );
      return { outcome: 'completed', captureId };
    }

    if (receiptState === 'failed') {
      const code = codeFromData(receiptData) ?? 'capture_failed';
      logger.warn(
        { sourceMessageKey, captureId, code },
        'Life voice capture failed',
      );
      return { outcome: 'failed', captureId, code };
    }

    if (receiptState === 'unresolved') {
      logger.info(
        { sourceMessageKey, captureId },
        'Life voice held for review',
      );
      return { outcome: 'review_in_life', captureId };
    }

    const processUrl = `${receiptUrl}/${encodeURIComponent(captureId)}/process`;
    if (input.onProcessDispatch) {
      try {
        input.onProcessDispatch();
      } catch {
        // Status notification stays failure-isolated; Life workflow continues.
      }
    }
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
    if (!processRes.ok || processBody['success'] !== true) {
      const code = errorCodeFromBody(processBody, processRes.status);
      logger.warn(
        { sourceMessageKey, captureId, status: processRes.status, code },
        'Life voice process rejected',
      );
      return { outcome: 'failed', captureId, code };
    }

    const processData = readDataEnvelope(processBody);
    if (!processData) {
      logger.warn(
        {
          sourceMessageKey,
          captureId,
          status: processRes.status,
          code: 'malformed_envelope',
        },
        'Life voice process malformed envelope',
      );
      return { outcome: 'failed', captureId, code: 'malformed_envelope' };
    }

    const processCaptureId = captureIdFromData(processData);
    if (!processCaptureId || processCaptureId !== captureId) {
      logger.warn(
        {
          sourceMessageKey,
          captureId,
          status: processRes.status,
          code: 'capture_id_mismatch',
        },
        'Life voice process identity mismatch',
      );
      return { outcome: 'failed', captureId, code: 'capture_id_mismatch' };
    }

    const processState = stateFromData(processData);
    if (processState === 'failed') {
      const code = codeFromData(processData) ?? 'capture_failed';
      logger.warn(
        { sourceMessageKey, captureId, code },
        'Life voice process capture failed',
      );
      return { outcome: 'failed', captureId, code };
    }

    const nextAction = nextActionFromData(processData);
    if (nextAction === 'redeliver') {
      const code = codeFromData(processData) ?? 'redeliver';
      logger.warn(
        { sourceMessageKey, captureId, code, nextAction },
        'Life voice needs redelivery',
      );
      return { outcome: 'failed', captureId, code };
    }
    if (processState === 'review_ready' && nextAction === 'resolve') {
      logger.info(
        { sourceMessageKey, captureId, nextAction },
        'Life voice held for review',
      );
      return { outcome: 'review_in_life', captureId, needsOwnerReview: true };
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

    const completeBody = await readJsonBody(completeRes);
    if (!completeRes.ok || completeBody['success'] !== true) {
      const code = errorCodeFromBody(completeBody, completeRes.status);
      logger.warn(
        { sourceMessageKey, captureId, status: completeRes.status, code },
        'Life voice complete rejected',
      );
      return { outcome: 'failed', captureId, code };
    }

    const completeData = readDataEnvelope(completeBody);
    if (!completeData) {
      logger.warn(
        {
          sourceMessageKey,
          captureId,
          status: completeRes.status,
          code: 'malformed_envelope',
        },
        'Life voice complete malformed envelope',
      );
      return { outcome: 'failed', captureId, code: 'malformed_envelope' };
    }

    const completeCaptureId = captureIdFromData(completeData);
    const completeState = stateFromData(completeData);
    if (completeCaptureId !== captureId || completeState !== 'completed') {
      logger.warn(
        { sourceMessageKey, captureId, code: 'completion_mismatch' },
        'Life voice completion mismatch',
      );
      return { outcome: 'failed', captureId, code: 'completion_mismatch' };
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
