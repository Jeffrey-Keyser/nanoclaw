import { describe, it, expect, vi } from 'vitest';

// Mock transcript-archiver before importing session-commands
vi.mock('./transcript-archiver.js', () => ({
  archiveTranscript: vi.fn().mockReturnValue(true),
}));

// Mock db before importing session-commands
vi.mock('./db/index.js', () => ({
  getRecentToolEvents: vi.fn().mockReturnValue([]),
}));

import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
  buildAgentStates,
  renderTopology,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects bare /clear', () => {
    expect(extractSessionCommand('/clear', trigger)).toBe('/clear');
  });

  it('detects bare /activity', () => {
    expect(extractSessionCommand('/activity', trigger)).toBe('/activity');
  });

  it('detects bare /topology', () => {
    expect(extractSessionCommand('/topology', trigger)).toBe('/topology');
  });

  it('detects /topology with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /topology', trigger)).toBe('/topology');
  });

  it('detects /activity with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /activity', trigger)).toBe('/activity');
  });

  it('detects /clear with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /clear', trigger)).toBe('/clear');
  });

  it('rejects /clear with extra text', () => {
    expect(extractSessionCommand('/clear now', trigger)).toBeNull();
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    deleteSession: vi.fn(),
    deleteInMemorySession: vi.fn(),
    groupFolder: 'test-group',
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('handles authorized /clear — deletes session and confirms', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/clear')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    // /clear no longer calls runAgent — archival is done host-side
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.deleteSession).toHaveBeenCalledWith('test-group');
    expect(deps.deleteInMemorySession).toHaveBeenCalledWith('test-group');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session cleared. Next message starts a fresh conversation.',
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('denies /clear for untrusted sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/clear', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.deleteSession).not.toHaveBeenCalled();
  });

  it('allows /clear for is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/clear', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.deleteSession).toHaveBeenCalledWith('test-group');
    expect(deps.deleteInMemorySession).toHaveBeenCalledWith('test-group');
  });

  it('still clears session even when archive throws', async () => {
    // archiveTranscript is host-side and errors are caught; clear still succeeds
    const { archiveTranscript } = await import('./transcript-archiver.js');
    (archiveTranscript as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full');
    });

    const deps = makeDeps({
      getSessionId: vi.fn().mockReturnValue('session-123'),
      claudeConfigDir: '/tmp/.claude',
      groupDir: '/tmp/group',
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/clear')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    // Error is caught — clear proceeds
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      '/clear failed. The session is unchanged.',
    );
  });

  it('handles /topology with no events — sends empty message', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/topology')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'No agent activity in the last 5 minutes.',
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('handles /topology with events — sends topology dashboard', async () => {
    const { getRecentToolEvents } = await import('./db/index.js');
    (getRecentToolEvents as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        session_id: 'sess-1',
        group_folder: 'agent-alpha',
        tool_name: 'Bash',
        hook_event: 'PostToolUse',
        timestamp: new Date().toISOString(),
      },
    ]);

    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/topology')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    const sentMessage = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentMessage).toContain('Agent Topology');
    expect(sentMessage).toContain('agent-alpha');
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('handles /topology error — sends failure message', async () => {
    const { getRecentToolEvents } = await import('./db/index.js');
    (getRecentToolEvents as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('db error');
      },
    );

    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/topology')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      '/topology failed. Could not retrieve agent state.',
    );

    // Restore mock
    (getRecentToolEvents as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });
});

describe('buildAgentStates', () => {
  it('returns empty array for no events', () => {
    expect(buildAgentStates([])).toEqual([]);
  });

  it('groups events by group_folder and uses most recent as last tool', () => {
    const now = Date.now();
    const events = [
      {
        session_id: 's1',
        group_folder: 'agent-a',
        tool_name: 'Read',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 10_000).toISOString(),
      },
      {
        session_id: 's1',
        group_folder: 'agent-a',
        tool_name: 'Bash',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 30_000).toISOString(),
      },
      {
        session_id: 's2',
        group_folder: 'agent-b',
        tool_name: 'Write',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 120_000).toISOString(),
      },
    ];

    const states = buildAgentStates(events);
    expect(states).toHaveLength(2);

    // agent-a is active (10s ago), agent-b is idle (120s ago)
    expect(states[0].name).toBe('agent-a');
    expect(states[0].lastTool).toBe('Read'); // first event is most recent (DESC order)
    expect(states[0].toolCount).toBe(2);
    expect(states[0].isActive).toBe(true);

    expect(states[1].name).toBe('agent-b');
    expect(states[1].lastTool).toBe('Write');
    expect(states[1].toolCount).toBe(1);
    expect(states[1].isActive).toBe(false);
    expect(states[1].status).toBe('idle');
  });

  it('marks very recent events as active (not thinking)', () => {
    const now = Date.now();
    const events = [
      {
        session_id: 's1',
        group_folder: 'agent-a',
        tool_name: 'Bash',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 2_000).toISOString(), // 2s ago
      },
    ];
    const states = buildAgentStates(events);
    expect(states[0].status).toBe('active');
  });

  it('marks older active events as thinking when PostToolUse', () => {
    const now = Date.now();
    const events = [
      {
        session_id: 's1',
        group_folder: 'agent-a',
        tool_name: 'Bash',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 15_000).toISOString(), // 15s ago
      },
    ];
    const states = buildAgentStates(events);
    expect(states[0].status).toBe('thinking');
  });

  it('sorts active agents before idle agents', () => {
    const now = Date.now();
    const events = [
      {
        session_id: 's2',
        group_folder: 'idle-agent',
        tool_name: 'Read',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 120_000).toISOString(),
      },
      {
        session_id: 's1',
        group_folder: 'active-agent',
        tool_name: 'Bash',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 2_000).toISOString(),
      },
    ];
    const states = buildAgentStates(events);
    expect(states[0].name).toBe('active-agent');
    expect(states[1].name).toBe('idle-agent');
  });

  it('respects custom activeThresholdMs', () => {
    const now = Date.now();
    const events = [
      {
        session_id: 's1',
        group_folder: 'agent-a',
        tool_name: 'Read',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 30_000).toISOString(),
      },
    ];
    // 10s threshold — 30s ago is idle
    expect(buildAgentStates(events, 10_000)[0].isActive).toBe(false);
    // 60s threshold — 30s ago is active
    expect(buildAgentStates(events, 60_000)[0].isActive).toBe(true);
  });
});

describe('renderTopology', () => {
  it('renders active and idle agents', () => {
    const output = renderTopology([
      {
        name: 'builder',
        sessionId: 's1',
        lastTool: 'Bash',
        lastTimestamp: new Date().toISOString(),
        toolCount: 5,
        isActive: true,
        status: 'active',
      },
      {
        name: 'reviewer',
        sessionId: 's2',
        lastTool: 'Read',
        lastTimestamp: new Date(Date.now() - 120_000).toISOString(),
        toolCount: 2,
        isActive: false,
        status: 'idle',
      },
    ]);

    expect(output).toContain('Agent Topology');
    expect(output).toContain('1 active');
    expect(output).toContain('1 idle');
    expect(output).toContain('2 total');
    expect(output).toContain('builder');
    expect(output).toContain('[ACTIVE]');
    expect(output).toContain('Bash');
    expect(output).toContain('5 tool calls');
    expect(output).toContain('reviewer');
    expect(output).toContain('last seen');
    expect(output).toContain('/activity for event log');
  });

  it('shows thinking status for thinking agents', () => {
    const output = renderTopology([
      {
        name: 'thinker',
        sessionId: 's1',
        lastTool: 'Read',
        lastTimestamp: new Date().toISOString(),
        toolCount: 3,
        isActive: true,
        status: 'thinking',
      },
    ]);
    expect(output).toContain('[THINKING]');
    expect(output).toContain('🟡');
  });

  it('stays within 3500 char limit', () => {
    // Create many agents to test truncation
    const agents = Array.from({ length: 100 }, (_, i) => ({
      name: `agent-with-a-very-long-name-number-${i}`,
      sessionId: `s${i}`,
      lastTool: 'Bash',
      lastTimestamp: new Date().toISOString(),
      toolCount: 999,
      isActive: true,
      status: 'active' as const,
    }));
    const output = renderTopology(agents);
    expect(output.length).toBeLessThanOrEqual(3500);
  });

  it('renders only idle section when no active agents', () => {
    const output = renderTopology([
      {
        name: 'sleeper',
        sessionId: 's1',
        lastTool: 'Read',
        lastTimestamp: new Date(Date.now() - 300_000).toISOString(),
        toolCount: 1,
        isActive: false,
        status: 'idle',
      },
    ]);
    expect(output).toContain('0 active');
    expect(output).toContain('1 idle');
    expect(output).toContain('Idle Agents:');
    expect(output).not.toContain('Active Agents:');
  });

  it('renders only active section when no idle agents', () => {
    const output = renderTopology([
      {
        name: 'worker',
        sessionId: 's1',
        lastTool: 'Bash',
        lastTimestamp: new Date().toISOString(),
        toolCount: 10,
        isActive: true,
        status: 'active',
      },
    ]);
    expect(output).toContain('1 active');
    expect(output).toContain('0 idle');
    expect(output).toContain('Active Agents:');
    expect(output).not.toContain('Idle Agents:');
  });
});
