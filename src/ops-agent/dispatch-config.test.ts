import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock agency-hq-client before imports
vi.mock('../agency-hq-client.js', () => ({
  agencyFetch: vi.fn(),
}));

import { agencyFetch } from '../agency-hq-client.js';
import {
  fetchDispatchConfig,
  refreshConfig,
  getAgentCliBin,
  getAgentRunnerBackend,
  getModel,
  startConfigPolling,
  stopConfigPolling,
  _resetForTest,
  _getCachedConfig,
} from './dispatch-config.js';

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe('dispatch-config', () => {
  beforeEach(() => {
    _resetForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopConfigPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('fetchDispatchConfig', () => {
    it('fetches config from /dispatch-config endpoint', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'claude-sonnet-4-5-20250929' },
        }),
      );

      const config = await fetchDispatchConfig();

      expect(agencyFetch).toHaveBeenCalledWith('/dispatch-config');
      expect(config).toEqual({
        provider: 'claude',
        model: 'claude-sonnet-4-5-20250929',
      });
    });

    it('returns null on non-OK response', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({ error: 'not found' }, false, 404),
      );

      const config = await fetchDispatchConfig();
      expect(config).toBeNull();
    });

    it('returns null on network error', async () => {
      vi.mocked(agencyFetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const config = await fetchDispatchConfig();
      expect(config).toBeNull();
    });

    it('returns null when data has no provider or model', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({ success: true, data: {} }),
      );

      const config = await fetchDispatchConfig();
      expect(config).toBeNull();
    });

    it('falls back provider to env var when only model is set', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { model: 'claude-sonnet-4-5-20250929' },
        }),
      );

      const config = await fetchDispatchConfig();
      expect(config).not.toBeNull();
      // Provider falls back to env AGENT_RUNNER_BACKEND (default: 'claude')
      expect(config!.provider).toBe('claude');
      expect(config!.model).toBe('claude-sonnet-4-5-20250929');
    });
  });

  describe('getAgentCliBin', () => {
    it('returns env-based default when no config cached', () => {
      expect(getAgentCliBin()).toBe('claude');
    });

    it('returns provider-mapped binary after config refresh', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'opus' },
        }),
      );

      await refreshConfig();
      expect(getAgentCliBin()).toBe('claude');
    });
  });

  describe('getAgentRunnerBackend', () => {
    it('returns env-based default when no config cached', () => {
      expect(getAgentRunnerBackend()).toBe('claude');
    });

    it('returns API provider after config refresh', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'opus' },
        }),
      );

      await refreshConfig();
      expect(getAgentRunnerBackend()).toBe('claude');
    });
  });

  describe('getModel', () => {
    it('returns empty string when no config cached', () => {
      expect(getModel()).toBe('');
    });

    it('returns model from API after refresh', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'claude-sonnet-4-5-20250929' },
        }),
      );

      await refreshConfig();
      expect(getModel()).toBe('claude-sonnet-4-5-20250929');
    });
  });

  describe('refreshConfig', () => {
    it('caches config on success', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );

      await refreshConfig();
      expect(_getCachedConfig()).toEqual({
        provider: 'claude',
        model: 'sonnet',
      });
    });

    it('keeps previous cache on failure', async () => {
      // First: successful fetch
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );
      await refreshConfig();

      // Second: failed fetch
      vi.mocked(agencyFetch).mockRejectedValueOnce(new Error('network'));
      await refreshConfig();

      // Still has the previous config
      expect(_getCachedConfig()).toEqual({
        provider: 'claude',
        model: 'sonnet',
      });
    });

    it('keeps previous cache when API returns empty', async () => {
      // First: successful fetch
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );
      await refreshConfig();

      // Second: empty data
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({ success: true, data: {} }),
      );
      await refreshConfig();

      expect(_getCachedConfig()).toEqual({
        provider: 'claude',
        model: 'sonnet',
      });
    });
  });

  describe('startConfigPolling', () => {
    it('fetches config immediately on start', async () => {
      vi.mocked(agencyFetch).mockReturnValue(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );

      await startConfigPolling();
      expect(agencyFetch).toHaveBeenCalledWith('/dispatch-config');
    });

    it('polls at 60s intervals', async () => {
      // Initial fetch
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );

      await startConfigPolling();

      const callsAfterStart = vi.mocked(agencyFetch).mock.calls.length;

      // Advance 60s — should trigger one poll
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(agencyFetch).mock.calls.length).toBe(callsAfterStart + 1);

      // Advance another 60s — should trigger another poll
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(agencyFetch).mock.calls.length).toBe(callsAfterStart + 2);
    });

    it('picks up config changes without restart', async () => {
      // First fetch: sonnet
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );

      await startConfigPolling();
      expect(getModel()).toBe('sonnet');

      // Second fetch (after 60s): opus
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'opus' },
        }),
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(getModel()).toBe('opus');
    });

    it('returns cleanup function that stops polling', async () => {
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'sonnet' },
        }),
      );

      const stop = await startConfigPolling();

      stop();

      // Should not poll again after stop
      const callsAfterStop = vi.mocked(agencyFetch).mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vi.mocked(agencyFetch).mock.calls.length).toBe(callsAfterStop);
    });
  });

  describe('end-to-end: config change via API is picked up by next task', () => {
    it('uses updated config after PUT to dispatch-config', async () => {
      // Initial config: sonnet
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'claude-sonnet-4-5-20250929' },
        }),
      );

      await startConfigPolling();
      expect(getAgentCliBin()).toBe('claude');
      expect(getModel()).toBe('claude-sonnet-4-5-20250929');

      // Simulate: user PUTs new config to Agency HQ, and next poll picks it up
      vi.mocked(agencyFetch).mockReturnValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'claude', model: 'claude-opus-4-6' },
        }),
      );

      await vi.advanceTimersByTimeAsync(60_000);

      // Worker should now use the new model
      expect(getModel()).toBe('claude-opus-4-6');
      expect(getAgentCliBin()).toBe('claude');
    });
  });
});
