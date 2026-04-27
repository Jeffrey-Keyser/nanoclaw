/**
 * Best-effort secret scrubber for activity-event payload summaries.
 *
 * Recall is what matters here, not precision — a missed match could leak a
 * real credential into the central DB / Telegram, while a false positive
 * just turns a benign string into `***REDACTED***`. Patterns aim at the
 * shapes that actually show up in tool args / results: bearer tokens,
 * `api_key=...` query params, and obvious env-var-ish bindings
 * (`FOO_TOKEN=...`, `OPENAI_API_KEY=...`).
 */
const REDACTED = '***REDACTED***';

const PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /api[-_]?key\s*[:=]\s*[A-Za-z0-9._\-+/=]+/gi,
  /(?:authorization|x-api-key)\s*[:=]\s*[A-Za-z0-9._\-+/=]+/gi,
  /\b[A-Z][A-Z0-9_]{2,}_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*[^\s,;]+/g,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const pat of PATTERNS) {
    out = out.replace(pat, REDACTED);
  }
  return out;
}
