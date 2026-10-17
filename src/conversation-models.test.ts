import { describe, it, expect } from 'vitest';
import { applyConversationModel } from './conversation-models.js';
const base = () => ({
  AGENT_RUNNER_BACKEND: 'opencode',
  AGENT_MODEL: 'opencode-go/deepseek-v4-flash',
  AGENT_CLI_BIN: 'opencode',
  AGENT_FALLBACK_BACKEND: 'codex',
  AGENT_FALLBACK_MODEL: 'gpt-5.6-terra',
  AGENT_FALLBACK_CLI_BIN: 'codex',
});
const central = {
  state: 'available' as const,
  row: {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    auto_fallback: false,
    updated_at: '2026-10-17T00:00:00Z',
  },
};
describe('conversation model configuration', () => {
  it('uses central tuple and disables inherited fallback', () => {
    const env = base();
    const s = applyConversationModel(env, undefined, central, false);
    expect(s.source).toBe('central');
    expect(s.model).toBe('gpt-6.1-sol');
    expect(env.AGENT_CLI_BIN).toBe('codex');
    expect(s.fallbackProvider).toBeNull();
  });
  it('preserves group choice and explicit null fallback', () => {
    const s = applyConversationModel(
      base(),
      { provider: 'codex', model: 'gpt-5.6-terra', fallbackProvider: null },
      central,
      false,
    );
    expect(s.source).toBe('group-override');
    expect(s.model).toBe('gpt-5.6-terra');
    expect(s.fallbackProvider).toBeNull();
  });
  it('resets foreign models on a provider-only override', () => {
    const s = applyConversationModel(
      base(),
      { provider: 'codex' },
      { state: 'missing' },
      false,
    );
    expect(s.model).toBe('');
  });
  it('retains legacy defaults on outage and explicit operator defaults', () => {
    expect(
      applyConversationModel(base(), undefined, { state: 'unavailable' }, false)
        .source,
    ).toBe('legacy-default');
    expect(
      applyConversationModel(base(), undefined, central, true).provider,
    ).toBe('opencode');
  });
  it('rejects malformed and foreign selections', () => {
    expect(() =>
      applyConversationModel(
        base(),
        undefined,
        { ...central, row: { ...central.row, model: 'sonnet' } },
        false,
      ),
    ).toThrow();
  });
});
