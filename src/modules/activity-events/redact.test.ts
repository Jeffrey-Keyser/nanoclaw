import { describe, it, expect } from 'vitest';

import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('redacts Bearer tokens', () => {
    const out = redactSecrets('Authorization: Bearer abc123.def-456_ghi/789=');
    expect(out).not.toContain('abc123');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts api_key= bindings', () => {
    const out = redactSecrets('GET /v1?api_key=sk-live-abc123def');
    expect(out).not.toContain('sk-live-abc123def');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts api-key (dash variant)', () => {
    const out = redactSecrets('x-api-key: secret-value-xyz');
    expect(out).not.toContain('secret-value-xyz');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts SHOUTY env-var-style secrets', () => {
    const out = redactSecrets('OPENAI_API_KEY=sk-proj-foo GITHUB_TOKEN=ghp_bar');
    expect(out).not.toContain('sk-proj-foo');
    expect(out).not.toContain('ghp_bar');
  });

  it('leaves benign text untouched', () => {
    const out = redactSecrets('GET /v1/messages with id=42');
    expect(out).toBe('GET /v1/messages with id=42');
  });

  it('redacts multiple matches in a single string', () => {
    const out = redactSecrets('Bearer abcdef and another Bearer xyz789');
    const matches = out.match(/\*\*\*REDACTED\*\*\*/g);
    expect(matches?.length).toBe(2);
  });
});
