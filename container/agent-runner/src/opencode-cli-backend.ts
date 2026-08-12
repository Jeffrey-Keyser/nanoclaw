import fs from 'fs';

import { runCli, withSystemContext } from './cli-process.js';
import type { RunnerBackend, RunOptions, RunResult } from './runner-backend.js';

interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  sessionId?: string;
  part?: { text?: string; sessionID?: string };
  error?: unknown;
}

export class OpenCodeCliBackend implements RunnerBackend {
  readonly supportsResume = true;

  constructor(
    private readonly cliBin = process.env.AGENT_CLI_BIN || 'opencode',
  ) {}

  async invoke(prompt: string, options: RunOptions): Promise<RunResult> {
    const args = ['run', '--auto', '--format', 'json', '--dir', options.cwd];
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--session', options.sessionId);

    const env = { ...options.env };
    if (options.mcpConfigPath) {
      const raw = JSON.parse(
        fs.readFileSync(options.mcpConfigPath, 'utf8'),
      ) as {
        mcpServers?: Record<
          string,
          { command: string; args?: string[]; env?: Record<string, string> }
        >;
      };
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        mcp: Object.fromEntries(
          Object.entries(raw.mcpServers || {}).map(([name, server]) => [
            name,
            {
              type: 'local',
              command: [server.command, ...(server.args || [])],
              environment: server.env || {},
              enabled: true,
            },
          ]),
        ),
      });
    }

    const result = await runCli(
      this.cliBin,
      args,
      withSystemContext(prompt, options.appendSystemPrompt),
      options.cwd,
      env,
    );

    let output = '';
    let sessionId = options.sessionId;
    let eventError = false;
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as OpenCodeEvent;
        sessionId =
          event.sessionID ||
          event.sessionId ||
          event.part?.sessionID ||
          sessionId;
        if (event.type === 'text' && event.part?.text)
          output += event.part.text;
        if (event.type === 'error' || event.error) eventError = true;
      } catch {
        // Ignore non-JSON log lines; OpenCode's JSON event stream is authoritative.
      }
    }

    const exitCode =
      result.exitCode === 0 && !eventError && output.trim()
        ? 0
        : result.exitCode || 1;
    return {
      output:
        output.trim() || result.stderr.trim() || result.stdout.trim() || null,
      newSessionId: sessionId,
      exitCode,
    };
  }
}
