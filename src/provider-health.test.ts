import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('child_process', () => ({ spawnSync }));

import { checkProvider } from './provider-health.js';

describe('provider health diagnostics', () => {
  beforeEach(() => spawnSync.mockReset());

  it('reports an available CLI and its version', () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: 'opencode 1.17.15\n',
      stderr: '',
      error: undefined,
    });

    expect(
      checkProvider('opencode', 'opencode-go/deepseek-v4-flash', 'opencode'),
    ).toMatchObject({
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      binary: 'opencode',
      available: true,
      version: 'opencode 1.17.15',
      error: null,
    });
  });

  it('reports a missing provider without throwing', () => {
    spawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn missing ENOENT'),
    });

    expect(checkProvider('codex', null, 'missing')).toMatchObject({
      provider: 'codex',
      model: null,
      binary: 'missing',
      available: false,
      version: null,
      error: 'spawn missing ENOENT',
    });
  });

  it('checks absolute provider binaries without executing them', () => {
    expect(checkProvider('opencode', 'test-model', '/bin/sh')).toMatchObject({
      available: true,
      binary: '/bin/sh',
      version: null,
      error: null,
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
