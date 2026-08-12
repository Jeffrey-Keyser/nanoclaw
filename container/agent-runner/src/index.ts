/**
 * NanoClaw host runner.
 *
 * Receives one invocation over stdin and emits a marker-framed result over
 * stdout. Provider selection is delegated to RunnerBackend implementations.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createBackend } from './backend-factory.js';
import { writeMcpConfig } from './mcp-config.js';
import type { RunOptions } from './runner-backend.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function readIfPresent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function buildInstructions(input: ContainerInput, groupDir: string): string {
  const globalDir = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
  const sections = [
    `You are ${input.assistantName || 'the configured assistant'} for the ${input.groupFolder} NanoClaw group. Execute actionable requests with your available tools; do not merely repeat instructions back to the user.`,
    !input.isMain ? readIfPresent(path.join(globalDir, 'CLAUDE.md')) : '',
    readIfPresent(path.join(groupDir, 'CLAUDE.local.md')),
  ].filter(Boolean);
  return sections.join('\n\n');
}

function buildRunOptions(
  input: ContainerInput,
  mcpConfigPath: string,
): RunOptions {
  const groupDir = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
  const additionalDirs = Object.entries(process.env)
    .filter(
      ([key, value]) => key.startsWith('NANOCLAW_EXTRA_DIR_') && Boolean(value),
    )
    .map(([, value]) => value!)
    .filter((dir) => fs.existsSync(dir));

  return {
    sessionId: input.sessionId,
    cwd: groupDir,
    mcpConfigPath,
    appendSystemPrompt: buildInstructions(input, groupDir),
    additionalDirs: additionalDirs.length > 0 ? additionalDirs : undefined,
    env: { ...process.env },
    model: process.env.AGENT_MODEL,
  };
}

async function main(): Promise<void> {
  let input: ContainerInput;
  try {
    input = JSON.parse(await readStdin()) as ContainerInput;
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exitCode = 1;
    return;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpConfigPath = writeMcpConfig({
    mcpServerPath: path.join(__dirname, 'ipc-mcp-stdio.js'),
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
  });

  try {
    const backend = createBackend();
    const prefix = input.isScheduledTask
      ? '[SCHEDULED TASK — execute this automation and return its result; do not echo the instructions.]\n\n'
      : '';
    const result = await backend.invoke(
      prefix + input.prompt,
      buildRunOptions(input, mcpConfigPath),
    );
    writeOutput({
      status: result.exitCode === 0 ? 'success' : 'error',
      result: result.output,
      newSessionId: result.newSessionId,
      error:
        result.exitCode === 0
          ? undefined
          : result.output || `CLI exited with code ${result.exitCode}`,
    });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(message);
    writeOutput({ status: 'error', result: null, error: message });
    process.exitCode = 1;
  } finally {
    try {
      fs.unlinkSync(mcpConfigPath);
    } catch {
      /* best effort */
    }
  }
}

void main();
