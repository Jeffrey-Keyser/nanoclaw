/**
 * Integration tests for tool call logging end-to-end pipeline.
 *
 * Tests verify that tool calls are captured through the full pipeline:
 *   1. IPC file path: hook output JSON → IPC directory → processJsonIpcDirectory → SQLite
 *   2. StreamToolLogger path: stream-json lines → StreamToolLogger → SQLite
 *
 * Both CEO and ops group folders are tested to ensure group_folder is correctly
 * propagated through the pipeline and stored in the database payload.
 *
 * Uses real IPC directories and in-memory SQLite database with proper cleanup.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from './db/index.js';
import {
  getRecentToolEvents,
  insertToolCallEvent,
} from './db/tool-events.js';
import { processJsonIpcDirectory } from './ipc/file-processor.js';
import { StreamToolLogger } from './stream-tool-logger.js';

// Shared test infrastructure
let tmpDir: string;

function createIpcDirs(groupFolder: string) {
  const groupDir = path.join(tmpDir, 'ipc', groupFolder);
  const toolEventsDir = path.join(groupDir, 'tool-events');
  const errorDir = path.join(tmpDir, 'ipc', 'errors');
  fs.mkdirSync(toolEventsDir, { recursive: true });
  fs.mkdirSync(errorDir, { recursive: true });
  return { groupDir, toolEventsDir, errorDir };
}

function makeHookOutput(overrides?: Partial<{
  tool_name: string;
  tool_use_id: string;
  session_id: string;
  hook_event: string;
  tool_input: string;
  tool_response: string;
}>) {
  return {
    tool_name: 'Bash',
    tool_use_id: `toolu_${Date.now()}`,
    session_id: `sess-${Date.now()}`,
    hook_event: 'PostToolUse',
    tool_input: '{"command":"echo hello"}',
    tool_response: 'hello',
    ...overrides,
  };
}

/** Noop logger matching pino.Logger shape for IPC processor. */
function noopLogger() {
  return {
    warn: () => {},
    debug: () => {},
    error: () => {},
    info: () => {},
  } as any;
}

/** IPC handler that mirrors the real handler in ipc.ts (lines 180-214). */
async function toolEventIpcHandler(
  data: unknown,
  sourceGroup: string,
): Promise<void> {
  const event = data as {
    tool_name?: string;
    tool_use_id?: string;
    session_id?: string;
    hook_event?: string;
    tool_input?: string;
    tool_response?: string;
  };
  if (!event.tool_name || !event.session_id) return;
  insertToolCallEvent({
    session_id: event.session_id,
    event_type: event.hook_event || 'PostToolUse',
    tool_name: event.tool_name,
    payload: {
      group_folder: sourceGroup,
      tool_use_id: event.tool_use_id ?? null,
      tool_input:
        typeof event.tool_input === 'string'
          ? event.tool_input
          : JSON.stringify(event.tool_input),
      tool_response:
        typeof event.tool_response === 'string'
          ? event.tool_response
          : JSON.stringify(event.tool_response),
    },
  });
}

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-logging-inttest-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── IPC file pipeline: hook JSON → IPC directory → database ───────────────

describe('IPC pipeline: CEO agent tool call capture', () => {
  it('captures a single Bash tool call for the ceo group', async () => {
    const { toolEventsDir, errorDir } = createIpcDirs('ceo');
    const hookOutput = makeHookOutput({
      session_id: 'ceo-sess-001',
      tool_name: 'Bash',
      tool_use_id: 'toolu_ceo_bash_1',
      tool_input: '{"command":"echo hello world"}',
      tool_response: 'hello world',
    });

    fs.writeFileSync(
      path.join(toolEventsDir, `${Date.now()}-Bash.json`),
      JSON.stringify(hookOutput),
    );

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'ceo',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ceo'),
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.session_id).toBe('ceo-sess-001');
    expect(event.tool_name).toBe('Bash');
    expect(event.event_type).toBe('PostToolUse');
    expect(event.created_at).toBeTruthy();

    const payload = JSON.parse(event.payload!);
    expect(payload.group_folder).toBe('ceo');
    expect(payload.tool_use_id).toBe('toolu_ceo_bash_1');
    expect(payload.tool_input).toBe('{"command":"echo hello world"}');
    expect(payload.tool_response).toBe('hello world');

    // JSON file should be consumed (deleted)
    expect(fs.readdirSync(toolEventsDir)).toHaveLength(0);
  });

  it('captures multiple sequential tool calls for the ceo group', async () => {
    const { toolEventsDir, errorDir } = createIpcDirs('ceo');
    const tools = [
      { name: 'Bash', input: '{"command":"ls -la"}', response: 'file1.txt\nfile2.txt' },
      { name: 'Read', input: '{"file_path":"/tmp/test.txt"}', response: 'file contents here' },
      { name: 'Edit', input: '{"file_path":"/tmp/test.txt"}', response: 'edit applied' },
    ];

    for (let i = 0; i < tools.length; i++) {
      const hookOutput = makeHookOutput({
        session_id: 'ceo-sess-multi',
        tool_name: tools[i].name,
        tool_use_id: `toolu_ceo_${i}`,
        tool_input: tools[i].input,
        tool_response: tools[i].response,
      });
      fs.writeFileSync(
        path.join(toolEventsDir, `${Date.now() + i}-${tools[i].name}.json`),
        JSON.stringify(hookOutput),
      );
    }

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'ceo',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ceo'),
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(3);

    // All events share the same session_id
    for (const event of events) {
      expect(event.session_id).toBe('ceo-sess-multi');
      const payload = JSON.parse(event.payload!);
      expect(payload.group_folder).toBe('ceo');
    }

    // All tool names present
    const toolNames = events.map((e) => e.tool_name).sort();
    expect(toolNames).toEqual(['Bash', 'Edit', 'Read']);

    // All files consumed
    expect(fs.readdirSync(toolEventsDir)).toHaveLength(0);
  });

  it('handles PostToolUseFailure events for the ceo group', async () => {
    const { toolEventsDir, errorDir } = createIpcDirs('ceo');
    const hookOutput = makeHookOutput({
      session_id: 'ceo-sess-fail',
      tool_name: 'Bash',
      hook_event: 'PostToolUseFailure',
      tool_input: '{"command":"rm -rf /"}',
      tool_response: 'permission denied',
    });

    fs.writeFileSync(
      path.join(toolEventsDir, `${Date.now()}-Bash.json`),
      JSON.stringify(hookOutput),
    );

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'ceo',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ceo'),
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('PostToolUseFailure');
    expect(events[0].session_id).toBe('ceo-sess-fail');

    const payload = JSON.parse(events[0].payload!);
    expect(payload.group_folder).toBe('ceo');
  });
});

describe('IPC pipeline: ops agent tool call capture', () => {
  it('captures a single Bash tool call for the ops group', async () => {
    const { toolEventsDir, errorDir } = createIpcDirs('ops');
    const hookOutput = makeHookOutput({
      session_id: 'ops-sess-001',
      tool_name: 'Bash',
      tool_use_id: 'toolu_ops_bash_1',
      tool_input: '{"command":"echo ops task output"}',
      tool_response: 'ops task output',
    });

    fs.writeFileSync(
      path.join(toolEventsDir, `${Date.now()}-Bash.json`),
      JSON.stringify(hookOutput),
    );

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'ops',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ops'),
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.session_id).toBe('ops-sess-001');
    expect(event.tool_name).toBe('Bash');
    expect(event.event_type).toBe('PostToolUse');
    expect(event.created_at).toBeTruthy();

    const payload = JSON.parse(event.payload!);
    expect(payload.group_folder).toBe('ops');
    expect(payload.tool_use_id).toBe('toolu_ops_bash_1');
    expect(payload.tool_input).toBe('{"command":"echo ops task output"}');
    expect(payload.tool_response).toBe('ops task output');

    expect(fs.readdirSync(toolEventsDir)).toHaveLength(0);
  });

  it('captures multiple sequential tool calls for the ops group', async () => {
    const { toolEventsDir, errorDir } = createIpcDirs('ops');
    const tools = [
      { name: 'Bash', input: '{"command":"npm test"}', response: 'Tests passed' },
      { name: 'Grep', input: '{"pattern":"TODO"}', response: 'src/index.ts:42:TODO fix' },
      { name: 'WebFetch', input: '{"url":"https://example.com"}', response: 'page content' },
    ];

    for (let i = 0; i < tools.length; i++) {
      const hookOutput = makeHookOutput({
        session_id: 'ops-sess-multi',
        tool_name: tools[i].name,
        tool_use_id: `toolu_ops_${i}`,
        tool_input: tools[i].input,
        tool_response: tools[i].response,
      });
      fs.writeFileSync(
        path.join(toolEventsDir, `${Date.now() + i}-${tools[i].name}.json`),
        JSON.stringify(hookOutput),
      );
    }

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'ops',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ops'),
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(3);

    for (const event of events) {
      expect(event.session_id).toBe('ops-sess-multi');
      const payload = JSON.parse(event.payload!);
      expect(payload.group_folder).toBe('ops');
    }

    const toolNames = events.map((e) => e.tool_name).sort();
    expect(toolNames).toEqual(['Bash', 'Grep', 'WebFetch']);

    expect(fs.readdirSync(toolEventsDir)).toHaveLength(0);
  });
});

// ─── StreamToolLogger pipeline: stream-json → database ─────────────────────

describe('StreamToolLogger pipeline: CEO agent tool call capture', () => {
  it('captures a Bash tool call from stream-json output for ceo', () => {
    const logger = new StreamToolLogger('ceo');

    // System init with session ID
    logger.processLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'ceo-stream-sess-001',
      }),
    );

    // Tool use
    logger.processLine(
      JSON.stringify({
        type: 'tool_use',
        id: 'toolu_ceo_stream_1',
        name: 'Bash',
        input: { command: 'echo hello from ceo' },
      }),
    );

    // Tool result
    logger.processLine(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_ceo_stream_1',
        content: 'hello from ceo',
      }),
    );

    expect(logger.getSessionId()).toBe('ceo-stream-sess-001');

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.session_id).toBe('ceo-stream-sess-001');
    expect(event.tool_name).toBe('Bash');
    expect(event.event_type).toBe('PostToolUse');
    expect(event.created_at).toBeTruthy();

    const payload = JSON.parse(event.payload!);
    expect(payload.group_folder).toBe('ceo');
    expect(payload.tool_use_id).toBe('toolu_ceo_stream_1');
    expect(payload.tool_input).toBe('{"command":"echo hello from ceo"}');
    expect(payload.tool_response).toBe('hello from ceo');
  });

  it('captures multiple tool calls from a single ceo stream session', () => {
    const logger = new StreamToolLogger('ceo');

    logger.processLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'ceo-stream-multi',
      }),
    );

    // First tool: Bash
    logger.processLine(
      JSON.stringify({
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'git status' },
      }),
    );
    logger.processLine(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'On branch main',
      }),
    );

    // Second tool: Read
    logger.processLine(
      JSON.stringify({
        type: 'tool_use',
        id: 'toolu_2',
        name: 'Read',
        input: { file_path: '/workspace/CLAUDE.md' },
      }),
    );
    logger.processLine(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        content: [{ type: 'text', text: '# Project README' }],
      }),
    );

    // Third tool: Edit
    logger.processLine(
      JSON.stringify({
        type: 'tool_use',
        id: 'toolu_3',
        name: 'Edit',
        input: { file_path: '/workspace/test.ts', old_string: 'foo', new_string: 'bar' },
      }),
    );
    logger.processLine(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_3',
        content: 'Edit applied successfully',
      }),
    );

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(3);

    for (const event of events) {
      expect(event.session_id).toBe('ceo-stream-multi');
      const payload = JSON.parse(event.payload!);
      expect(payload.group_folder).toBe('ceo');
    }

    const toolNames = events.map((e) => e.tool_name).sort();
    expect(toolNames).toEqual(['Bash', 'Edit', 'Read']);
  });
});

describe('StreamToolLogger pipeline: ops agent tool call capture', () => {
  it('captures a Bash tool call from stream-json output for ops', () => {
    const logger = new StreamToolLogger('ops');

    logger.processLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'ops-stream-sess-001',
      }),
    );

    logger.processLine(
      JSON.stringify({
        type: 'tool_use',
        id: 'toolu_ops_stream_1',
        name: 'Bash',
        input: { command: 'echo ops task running' },
      }),
    );

    logger.processLine(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_ops_stream_1',
        content: 'ops task running',
      }),
    );

    expect(logger.getSessionId()).toBe('ops-stream-sess-001');

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.session_id).toBe('ops-stream-sess-001');
    expect(event.tool_name).toBe('Bash');
    expect(event.event_type).toBe('PostToolUse');
    expect(event.created_at).toBeTruthy();

    const payload = JSON.parse(event.payload!);
    expect(payload.group_folder).toBe('ops');
    expect(payload.tool_use_id).toBe('toolu_ops_stream_1');
    expect(payload.tool_input).toBe('{"command":"echo ops task running"}');
    expect(payload.tool_response).toBe('ops task running');
  });

  it('captures multiple tool calls from a single ops stream session', () => {
    const logger = new StreamToolLogger('ops');

    logger.processLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'ops-stream-multi',
      }),
    );

    // First tool: Bash
    logger.processLine(
      JSON.stringify({
        type: 'tool_use',
        id: 'toolu_o1',
        name: 'Bash',
        input: { command: 'npm run build' },
      }),
    );
    logger.processLine(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_o1',
        content: 'Build succeeded',
      }),
    );

    // Second tool: Grep
    logger.processLine(
      JSON.stringify({
        type: 'tool_use',
        id: 'toolu_o2',
        name: 'Grep',
        input: { pattern: 'error', path: '/workspace' },
      }),
    );
    logger.processLine(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_o2',
        content: [{ type: 'text', text: 'No errors found' }],
      }),
    );

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(2);

    for (const event of events) {
      expect(event.session_id).toBe('ops-stream-multi');
      const payload = JSON.parse(event.payload!);
      expect(payload.group_folder).toBe('ops');
    }

    const toolNames = events.map((e) => e.tool_name).sort();
    expect(toolNames).toEqual(['Bash', 'Grep']);
  });
});

// ─── Cross-group isolation ─────────────────────────────────────────────────

describe('cross-group isolation: CEO and ops events are distinguished', () => {
  it('IPC pipeline: events from ceo and ops groups are stored with correct group_folder', async () => {
    const ceo = createIpcDirs('ceo');
    const ops = createIpcDirs('ops');

    // Write CEO event
    fs.writeFileSync(
      path.join(ceo.toolEventsDir, `${Date.now()}-Bash.json`),
      JSON.stringify(makeHookOutput({
        session_id: 'ceo-isolation-sess',
        tool_name: 'Bash',
        tool_use_id: 'toolu_ceo_iso',
        tool_input: '{"command":"echo ceo"}',
        tool_response: 'ceo',
      })),
    );

    // Write ops event
    fs.writeFileSync(
      path.join(ops.toolEventsDir, `${Date.now()}-Bash.json`),
      JSON.stringify(makeHookOutput({
        session_id: 'ops-isolation-sess',
        tool_name: 'Bash',
        tool_use_id: 'toolu_ops_iso',
        tool_input: '{"command":"echo ops"}',
        tool_response: 'ops',
      })),
    );

    // Process CEO IPC
    await processJsonIpcDirectory({
      directory: ceo.toolEventsDir,
      errorDirectory: ceo.errorDir,
      sourceGroup: 'ceo',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ceo'),
    });

    // Process ops IPC
    await processJsonIpcDirectory({
      directory: ops.toolEventsDir,
      errorDirectory: ops.errorDir,
      sourceGroup: 'ops',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ops'),
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(2);

    const ceoEvent = events.find((e) => e.session_id === 'ceo-isolation-sess')!;
    const opsEvent = events.find((e) => e.session_id === 'ops-isolation-sess')!;

    expect(ceoEvent).toBeTruthy();
    expect(opsEvent).toBeTruthy();

    const ceoPayload = JSON.parse(ceoEvent.payload!);
    const opsPayload = JSON.parse(opsEvent.payload!);

    expect(ceoPayload.group_folder).toBe('ceo');
    expect(opsPayload.group_folder).toBe('ops');
  });

  it('StreamToolLogger: events from ceo and ops are stored with correct group_folder', () => {
    const ceoLogger = new StreamToolLogger('ceo');
    const opsLogger = new StreamToolLogger('ops');

    // CEO session
    ceoLogger.processLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ceo-iso-stream' }),
    );
    ceoLogger.processLine(
      JSON.stringify({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo ceo' } }),
    );
    ceoLogger.processLine(
      JSON.stringify({ type: 'tool_result', tool_use_id: 't1', content: 'ceo' }),
    );

    // Ops session
    opsLogger.processLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ops-iso-stream' }),
    );
    opsLogger.processLine(
      JSON.stringify({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo ops' } }),
    );
    opsLogger.processLine(
      JSON.stringify({ type: 'tool_result', tool_use_id: 't2', content: 'ops' }),
    );

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(2);

    const ceoEvent = events.find((e) => e.session_id === 'ceo-iso-stream')!;
    const opsEvent = events.find((e) => e.session_id === 'ops-iso-stream')!;

    expect(ceoEvent).toBeTruthy();
    expect(opsEvent).toBeTruthy();

    expect(JSON.parse(ceoEvent.payload!).group_folder).toBe('ceo');
    expect(JSON.parse(opsEvent.payload!).group_folder).toBe('ops');
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('edge cases in tool call capture pipeline', () => {
  it('IPC pipeline: skips events with missing session_id', async () => {
    const { toolEventsDir, errorDir } = createIpcDirs('ceo');
    const hookOutput = {
      tool_name: 'Bash',
      tool_use_id: 'toolu_no_session',
      // session_id intentionally omitted
      hook_event: 'PostToolUse',
      tool_input: '{"command":"echo"}',
      tool_response: 'output',
    };

    fs.writeFileSync(
      path.join(toolEventsDir, `${Date.now()}-Bash.json`),
      JSON.stringify(hookOutput),
    );

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'ceo',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ceo'),
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(0);
  });

  it('IPC pipeline: skips events with missing tool_name', async () => {
    const { toolEventsDir, errorDir } = createIpcDirs('ops');
    const hookOutput = {
      // tool_name intentionally omitted
      tool_use_id: 'toolu_no_tool',
      session_id: 'ops-sess-no-tool',
      hook_event: 'PostToolUse',
      tool_input: '{"command":"echo"}',
      tool_response: 'output',
    };

    fs.writeFileSync(
      path.join(toolEventsDir, `${Date.now()}-Unknown.json`),
      JSON.stringify(hookOutput),
    );

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'ops',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ops'),
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(0);
  });

  it('IPC pipeline: handles non-existent tool-events directory gracefully', async () => {
    const nonExistentDir = path.join(tmpDir, 'does-not-exist', 'tool-events');
    const errorDir = path.join(tmpDir, 'ipc', 'errors');
    fs.mkdirSync(errorDir, { recursive: true });

    // processJsonIpcDirectory returns early if directory doesn't exist
    await processJsonIpcDirectory({
      directory: nonExistentDir,
      errorDirectory: errorDir,
      sourceGroup: 'ceo',
      createLogger: () => noopLogger(),
      handle: async () => {},
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(0);
  });

  it('IPC pipeline: quarantines malformed JSON files to error directory', async () => {
    const { toolEventsDir, errorDir } = createIpcDirs('ops');

    fs.writeFileSync(
      path.join(toolEventsDir, `${Date.now()}-Bad.json`),
      'this is not valid JSON{{{',
    );

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'ops',
      createLogger: () => noopLogger(),
      handle: async (data) => toolEventIpcHandler(data, 'ops'),
    });

    // No events stored
    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(0);

    // Malformed file moved to error directory
    const errorFiles = fs.readdirSync(errorDir);
    expect(errorFiles.length).toBeGreaterThanOrEqual(1);
    expect(errorFiles[0]).toMatch(/^ops-/);
  });

  it('StreamToolLogger: tool_response truncated to 2000 chars', () => {
    const logger = new StreamToolLogger('ceo');
    const longContent = 'x'.repeat(3000);

    logger.processLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ceo-trunc-sess' }),
    );
    logger.processLine(
      JSON.stringify({ type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
    );
    logger.processLine(
      JSON.stringify({ type: 'tool_result', tool_use_id: 't1', content: longContent }),
    );

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);

    const payload = JSON.parse(events[0].payload!);
    expect(payload.tool_response.length).toBe(2000);
  });
});
