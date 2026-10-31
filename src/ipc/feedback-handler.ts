import type pino from 'pino';

import { logger } from '../logger.js';

export interface FeedbackIpcData {
  type: string;
  feedbackType?: string;
  title?: string;
  description?: string;
  email?: string;
}

/** Live Feedback Registry host. `api.feedback.jeffreykeyser.net` is retired (NXDOMAIN). */
export const DEFAULT_FEEDBACK_REGISTRY_URL =
  'https://feedback.jeffreykeyser.net';
/** Registered app id in the registry's `feedback.apps` table. */
export const FEEDBACK_APP_ID = 'nanoclaw';
/** Registry submission types; IPC `feedbackType` maps 1:1 onto these. */
export const FEEDBACK_TYPES = ['bug', 'feature', 'question'] as const;

/**
 * Resolve the registry submission endpoint. `FEEDBACK_REGISTRY_URL` (base URL,
 * e.g. from nanoclaw's .env) overrides the live default; read per call so the
 * value is never frozen at import time.
 */
export function feedbackSubmitUrl(): string {
  const base = (
    process.env.FEEDBACK_REGISTRY_URL || DEFAULT_FEEDBACK_REGISTRY_URL
  ).replace(/\/+$/, '');
  return `${base}/api/v1/feedback`;
}

/**
 * Handle feedback-related IPC commands.
 */
export async function handleFeedbackIpc(
  data: FeedbackIpcData,
  sourceGroup: string,
  log?: pino.Logger,
): Promise<void> {
  const _log = log ?? logger;

  const feedbackUrl = feedbackSubmitUrl();

  if (
    !data.feedbackType ||
    !(FEEDBACK_TYPES as readonly string[]).includes(data.feedbackType)
  ) {
    _log.warn(
      { feedbackType: data.feedbackType },
      'Invalid feedback type — must be "bug", "feature" or "question"',
    );
    return;
  }
  if (!data.title || typeof data.title !== 'string' || !data.title.trim()) {
    _log.warn('Feedback missing required field: title');
    return;
  }
  if (
    !data.description ||
    typeof data.description !== 'string' ||
    !data.description.trim()
  ) {
    _log.warn('Feedback missing required field: description');
    return;
  }

  // Registry contract (POST /api/v1/feedback): appId, type, title (<=255),
  // description required; email and metadata (object) optional. Unknown
  // top-level fields are ignored, so provenance lives in metadata.
  const feedbackPayload = {
    appId: FEEDBACK_APP_ID,
    type: data.feedbackType,
    title: Array.from(data.title.trim()).slice(0, 255).join(''),
    description: data.description,
    ...(data.email && typeof data.email === 'string'
      ? { email: data.email }
      : {}),
    metadata: { source: 'nanoclaw', sourceGroup },
  };

  try {
    const res = await fetch(feedbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedbackPayload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      _log.error(
        { status: res.status, body, url: feedbackUrl },
        'Feedback API returned non-OK status',
      );
    } else {
      _log.info(
        { feedbackType: data.feedbackType, title: data.title, sourceGroup },
        'Feedback submitted via IPC',
      );
    }
  } catch (err) {
    _log.error({ err }, 'Failed to POST feedback to Feedback Registry');
  }
}
