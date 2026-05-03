import { spawn } from 'node:child_process';

const unit = process.env.NANOCLAW_SYSTEMD_UNIT || 'nanoclaw.service';
const timeoutMs = parseInt(process.env.RELOAD_SERVICE_TIMEOUT_MS || '30000', 10);
const intervalMs = parseInt(process.env.RELOAD_SERVICE_INTERVAL_MS || '1000', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      });
    });
  });
}

async function waitForActive(deadline) {
  let lastState = 'unknown';

  while (Date.now() < deadline) {
    const result = await run('systemctl', ['--user', 'is-active', unit]);
    lastState = result.stdout || result.stderr || `exit ${result.code}`;
    if (result.code === 0 && result.stdout === 'active') {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${unit} to become active (last state: ${lastState})`);
}

async function runHealthCheck() {
  const env = {
    ...process.env,
    SKILL_SERVER_PORT: process.env.SKILL_SERVER_PORT || '3101',
  };
  const result = await run('node', ['scripts/health-check.mjs'], { env });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'Health check failed');
  }
  if (result.stdout) {
    console.log(result.stdout);
  }
}

const restart = await run('systemctl', ['--user', 'restart', unit]);
if (restart.code !== 0) {
  throw new Error(restart.stderr || restart.stdout || `Failed to restart ${unit}`);
}

const deadline = Date.now() + timeoutMs;
await waitForActive(deadline);
await runHealthCheck();
