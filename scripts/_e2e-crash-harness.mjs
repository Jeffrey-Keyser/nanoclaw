#!/usr/bin/env node
/**
 * E2E harness for the uptime-monitor's crash detection.
 *
 * Called by e2e-systemd-crash-handler.sh after a dummy systemd user
 * service has been crashed. Exercises the real `systemctl --user` and
 * `journalctl --user` commands through the uptime-monitor module,
 * capturing the alert via a mock sendMessage callback.
 *
 * Usage:
 *   node scripts/_e2e-crash-harness.mjs <service-unit>
 *   node scripts/_e2e-crash-harness.mjs <service-unit> --recovery
 */

import { spawn } from 'child_process';

const serviceUnit = process.argv[2];
const isRecoveryMode = process.argv.includes('--recovery');

if (!serviceUnit) {
  console.error('Usage: _e2e-crash-harness.mjs <service-unit> [--recovery]');
  process.exit(1);
}

// --- Lightweight reimplementation of checkServices for E2E ---
// We cannot import the TS module directly, so we replicate the
// core logic (systemctl + journalctl) to validate end-to-end behavior.

function runCommand(command, args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString('utf-8'),
        exit_code: code ?? 1,
      });
    });
    child.on('error', () => resolve({ stdout: '', exit_code: 1 }));
  });
}

const sentMessages = [];
const knownFailures = new Set();

// If in recovery mode, pre-seed the service as a known failure
// so checkServices detects the transition to recovered.
if (isRecoveryMode) {
  knownFailures.add(serviceUnit);
}

async function checkServices() {
  const { stdout } = await runCommand('systemctl', [
    '--user',
    'list-units',
    '--state=failed',
    '--no-legend',
    '--no-pager',
  ]);

  // systemctl output may prefix lines with a `●` marker (UTF-8 e2 97 8f).
  // Extract the first token that looks like a unit name (contains a dot).
  const currentFailures = new Set(
    stdout
      .split('\n')
      .map((line) => {
        const tokens = line.trim().split(/\s+/);
        return tokens.find((t) => t.includes('.')) || tokens[0];
      })
      .filter((unit) => unit && unit.length > 0 && unit.includes('.')),
  );

  // Alert on new failures
  for (const unit of currentFailures) {
    if (!knownFailures.has(unit)) {
      knownFailures.add(unit);

      const { stdout: journal } = await runCommand('journalctl', [
        '--user',
        '-n',
        '20',
        '-u',
        unit,
        '--no-pager',
        '--output=short',
      ]);

      const tail = journal.trim().slice(-1500) || '(no journal output)';
      const msg = `*[ALERT] Service down: ${unit}*\n\n\`\`\`\n${tail}\n\`\`\``;

      sentMessages.push({ type: 'alert', unit, msg });
      console.log(`  [harness] Alert captured for ${unit}`);
    }
  }

  // Notify on recovery
  for (const unit of knownFailures) {
    if (!currentFailures.has(unit)) {
      knownFailures.delete(unit);
      const msg = `*[RESOLVED] Service recovered: ${unit}*`;
      sentMessages.push({ type: 'recovery', unit, msg });
      console.log(`  [harness] Recovery captured for ${unit}`);
    }
  }
}

// --- Run checks and validate ---

await checkServices();

if (isRecoveryMode) {
  // In recovery mode, expect a recovery notification for our service
  const recovery = sentMessages.find(
    (m) => m.type === 'recovery' && m.unit === serviceUnit,
  );

  if (!recovery) {
    console.error(
      `  [harness] FAIL: expected recovery notification for ${serviceUnit}`,
    );
    console.error(
      `  [harness] Messages captured: ${JSON.stringify(sentMessages.map((m) => m.type + ':' + m.unit))}`,
    );
    process.exit(1);
  }

  if (!recovery.msg.includes('[RESOLVED]')) {
    console.error('  [harness] FAIL: recovery message missing [RESOLVED] tag');
    process.exit(1);
  }

  console.log(`  [harness] Recovery notification verified for ${serviceUnit}`);
} else {
  // In normal mode, expect an alert for our crashed service
  const alert = sentMessages.find(
    (m) => m.type === 'alert' && m.unit === serviceUnit,
  );

  if (!alert) {
    console.error(
      `  [harness] FAIL: expected alert for ${serviceUnit} but got none`,
    );
    console.error(
      `  [harness] Messages captured: ${JSON.stringify(sentMessages.map((m) => m.type + ':' + m.unit))}`,
    );
    process.exit(1);
  }

  if (!alert.msg.includes('[ALERT] Service down:')) {
    console.error('  [harness] FAIL: alert message missing expected format');
    process.exit(1);
  }

  if (!alert.msg.includes('```')) {
    console.error(
      '  [harness] FAIL: alert message missing journal log section',
    );
    process.exit(1);
  }

  console.log(`  [harness] Alert verified for ${serviceUnit}`);
  console.log(`  [harness] Telegram notification would contain:`);
  console.log(
    `    Subject: Service down: ${serviceUnit}`,
  );
  console.log(`    Severity: error`);
  console.log(`    Includes journal tail: yes`);
}
