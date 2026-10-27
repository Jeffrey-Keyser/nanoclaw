import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
const saved = vi.hoisted(() => new Map<string, string>());
vi.mock('./db/index.js', () => ({
  getRouterState: (key: string) => saved.get(key),
  setRouterState: (key: string, value: string) => saved.set(key, value),
}));

import { spawn } from 'child_process';
import {
  checkServices,
  parseFailedServices,
  type UptimeMonitorDeps,
} from './uptime-monitor.js';

const FIVE_MINUTES = 5 * 60_000;
const DAY = 24 * 60 * 60_000;
const failed = '● example.service loaded failed failed Example service\n';

function result(stdout = failed, exitCode = 0) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: { resume: () => void };
    };
    child.stdout = new EventEmitter();
    child.stderr = { resume: vi.fn() };
    Promise.resolve().then(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child as never;
  });
}

function deps(): UptimeMonitorDeps {
  return {
    registeredGroups: () => ({
      owner: {
        name: 'Owner',
        folder: 'main',
        trigger: '',
        added_at: '',
        isMain: true,
      },
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

async function poll(d: UptimeMonitorDeps, stdout = failed, code = 0) {
  result(stdout, code);
  await checkServices(d);
}

beforeEach(() => {
  saved.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('uptime monitor', () => {
  it('parses actual service names with or without systemd bullets', () => {
    expect([
      ...parseFailedServices(
        failed +
          'other.service not-found failed failed Other\n' +
          'unit.timer loaded failed failed Timer\n2 loaded units listed.\n',
      ),
    ]).toEqual(['example.service', 'other.service']);
  });

  it('waits for confirmation, then sends actionable failure details once', async () => {
    const d = deps();
    await poll(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(d.sendMessage).mock.calls[0][1];
    expect(msg).toContain(
      '[ACTION NEEDED] User service failed: example.service',
    );
    expect(msg).toContain('Host:');
    expect(msg).toContain('Impact:');
    expect(msg).toContain('has not attempted a restart');
    expect(msg).toContain("systemctl --user status 'example.service'");
    expect(msg).not.toContain('-- No entries --');
    expect(spawn).toHaveBeenCalledWith(
      'systemctl',
      expect.arrayContaining(['--plain', '--type=service']),
      expect.anything(),
    );
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('retains alert deduplication across module reloads (process restarts)', async () => {
    const d = deps();
    await poll(d);
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    vi.resetModules();
    const reloaded = await import('./uptime-monitor.js');
    vi.advanceTimersByTime(FIVE_MINUTES);
    result();
    await reloaded.checkServices(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps brief failures quiet and groups recoveries into one daily summary', async () => {
    const d = deps();
    await poll(d);
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d, '');
    expect(d.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DAY - FIVE_MINUTES);
    await poll(d, '');
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage).toHaveBeenCalledWith(
      'owner',
      expect.stringContaining('Daily service recovery summary'),
    );
    expect(d.sendMessage).toHaveBeenCalledWith(
      'owner',
      expect.stringContaining('example.service: 1 recovery'),
    );
    await poll(d, '');
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not claim recovery when systemctl fails', async () => {
    const d = deps();
    await poll(d);
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    const before = saved.get('uptime_monitor_v1');
    await poll(d, '', 1);
    expect(saved.get('uptime_monitor_v1')).toBe(before);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('alerts on a new confirmed failure after a recovery', async () => {
    const d = deps();
    await poll(d);
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    await poll(d, '');
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    await poll(d);
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('requires fresh confirmation after a long monitoring gap', async () => {
    const d = deps();
    await poll(d);
    vi.advanceTimersByTime(60 * 60_000);
    await poll(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('retries failed alert delivery without marking the incident alerted', async () => {
    const d = deps();
    vi.mocked(d.sendMessage).mockRejectedValueOnce(new Error('offline'));
    await poll(d);
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    expect(
      JSON.parse(saved.get('uptime_monitor_v1')!).failures['example.service']
        .alerted,
    ).toBe(false);
    vi.advanceTimersByTime(FIVE_MINUTES);
    await poll(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(saved.get('uptime_monitor_v1')!).failures['example.service']
        .alerted,
    ).toBe(true);
  });

  it('retains daily summary entries if delivery fails', async () => {
    const d = deps();
    await poll(d);
    await poll(d, '');
    vi.advanceTimersByTime(DAY);
    vi.mocked(d.sendMessage).mockRejectedValueOnce(new Error('offline'));
    await expect(poll(d, '')).rejects.toThrow('offline');
    expect(JSON.parse(saved.get('uptime_monitor_v1')!).recoveries).toEqual({
      'example.service': 1,
    });
    await poll(d, '');
    expect(d.sendMessage).toHaveBeenCalledTimes(2);
    expect(JSON.parse(saved.get('uptime_monitor_v1')!).recoveries).toEqual({});
  });

  it('queues recoveries while no main group is registered', async () => {
    const d = deps();
    const groups = d.registeredGroups;
    d.registeredGroups = () => ({});
    await poll(d);
    await poll(d, '');
    vi.advanceTimersByTime(DAY);
    await poll(d, '');
    expect(d.sendMessage).not.toHaveBeenCalled();
    d.registeredGroups = groups;
    await poll(d, '');
    expect(d.sendMessage).toHaveBeenCalledWith(
      'owner',
      expect.stringContaining('example.service'),
    );
  });

  it('starts fresh safely if the saved state is corrupt', async () => {
    saved.set('uptime_monitor_v1', '{bad json');
    const d = deps();
    await poll(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(
      JSON.parse(saved.get('uptime_monitor_v1')!).failures['example.service'],
    ).toBeDefined();
  });
});
