import { spawn } from 'child_process';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCli(
  binary: string,
  args: string[],
  prompt: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) =>
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`)),
    );
    child.on('close', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 }),
    );
    child.stdin.end(prompt);
  });
}

export function withSystemContext(
  prompt: string,
  instructions?: string,
): string {
  if (!instructions) return prompt;
  return `<system_context>\n${instructions}\n</system_context>\n\n<request>\n${prompt}\n</request>`;
}
