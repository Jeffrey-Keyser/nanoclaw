import fs from 'fs';

import { runCli, withSystemContext } from './cli-process.js';
import type { RunnerBackend, RunOptions, RunResult } from './runner-backend.js';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  message?: string;
}

export class CodexCliBackend implements RunnerBackend {
  readonly supportsResume = true;

  constructor(private readonly cliBin = process.env.AGENT_CLI_BIN || 'codex') {}

  async invoke(prompt: string, options: RunOptions): Promise<RunResult> {
    const args = ['exec'];
    if (options.sessionId) args.push('resume');
    if (options.mcpConfigPath) {
      const raw = JSON.parse(
        fs.readFileSync(options.mcpConfigPath, 'utf8'),
      ) as {
        mcpServers?: Record<
          string,
          { command: string; args?: string[]; env?: Record<string, string> }
        >;
      };
      for (const [name, server] of Object.entries(raw.mcpServers || {})) {
        args.push(
          '-c',
          `mcp_servers.${name}.command=${tomlString(server.command)}`,
        );
        args.push(
          '-c',
          `mcp_servers.${name}.args=${tomlArray(server.args || [])}`,
        );
        if (server.env && Object.keys(server.env).length > 0) {
          args.push('-c', `mcp_servers.${name}.env=${tomlTable(server.env)}`);
        }
      }
    }
    args.push(
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    );
    if (!options.sessionId) args.push('--cd', options.cwd);
    if (!options.sessionId && options.additionalDirs) {
      for (const dir of options.additionalDirs) args.push('--add-dir', dir);
    }
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push(options.sessionId);
    args.push('-');

    const result = await runCli(
      this.cliBin,
      args,
      withSystemContext(prompt, options.appendSystemPrompt),
      options.cwd,
      options.env,
    );

    let output = '';
    let sessionId = options.sessionId;
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as CodexEvent;
        if (event.type === 'thread.started' && event.thread_id)
          sessionId = event.thread_id;
        if (
          event.type === 'item.completed' &&
          event.item?.type === 'agent_message' &&
          event.item.text
        ) {
          output = event.item.text;
        }
      } catch {
        // Ignore non-JSON diagnostics.
      }
    }

    return {
      output:
        output.trim() || result.stderr.trim() || result.stdout.trim() || null,
      newSessionId: sessionId,
      exitCode: result.exitCode,
    };
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function tomlTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${JSON.stringify(key)}=${tomlString(value)}`)
    .join(',')}}`;
}
