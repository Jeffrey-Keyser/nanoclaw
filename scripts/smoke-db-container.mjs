import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import net from 'net';
import path from 'path';
import process from 'process';

const repoRoot = path.resolve(path.dirname(process.argv[1]), '..');
const dataDir = path.join(repoRoot, 'data');
const dbPath = path.join(dataDir, 'v2.db');
const logPath = path.join(repoRoot, 'logs', 'nanoclaw.log');
const cliSocketPath = path.join(dataDir, 'cli.sock');

const agentName = process.env.SMOKE_AGENT_NAME || 'Milo';
const agentSlug = agentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
const maxReplyWaitMs = parseInt(process.env.SMOKE_REPLY_TIMEOUT_MS || '60000', 10);
const spawnWaitMs = parseInt(process.env.SMOKE_SPAWN_TIMEOUT_MS || '15000', 10);
const stableWindowMs = parseInt(process.env.SMOKE_STABLE_WINDOW_MS || '5000', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

function readLogDelta(startOffset) {
  const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  if (size <= startOffset) {
    return '';
  }
  const fd = fs.openSync(logPath, 'r');
  try {
    const buf = Buffer.alloc(size - startOffset);
    fs.readSync(fd, buf, 0, buf.length, startOffset);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function ensureCliDestination(db, agentGroupId) {
  let cliGroup = db
    .prepare(
      'SELECT id, channel_type, platform_id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?',
    )
    .get('cli', 'local');

  if (!cliGroup) {
    cliGroup = {
      id: `mg-smoke-cli-local`,
      channel_type: 'cli',
      platform_id: 'local',
      name: 'CLI local',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO messaging_groups (
        id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at
      ) VALUES (
        @id, @channel_type, @platform_id, @name, @is_group, @unknown_sender_policy, @created_at
      )`,
    ).run(cliGroup);
  }

  const existingDest = db
    .prepare(
      "SELECT local_name FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ?",
    )
    .get(agentGroupId, cliGroup.id);
  if (!existingDest) {
    let localName = 'cli-local';
    let suffix = 2;
    while (
      db
        .prepare(
          'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND local_name = ? LIMIT 1',
        )
        .get(agentGroupId, localName)
    ) {
      localName = `cli-local-${suffix}`;
      suffix += 1;
    }
    db.prepare(
      `INSERT INTO agent_destinations (
        agent_group_id, local_name, target_type, target_id, created_at
      ) VALUES (?, ?, 'channel', ?, ?)`,
    ).run(agentGroupId, localName, cliGroup.id, new Date().toISOString());
  }
}

function runningContainersForAgent() {
  const output = execFileSync(
    'docker',
    ['ps', '--format', '{{.Names}}', '--filter', `name=nanoclaw-v2-${agentSlug}-`],
    { encoding: 'utf8' },
  ).trim();
  if (!output) {
    return [];
  }
  return output.split('\n').filter(Boolean);
}

function stopRunningContainers(containers) {
  for (const container of containers) {
    execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' });
  }
}

function sessionDir(agentGroupId, sessionId) {
  return path.join(dataDir, 'v2-sessions', agentGroupId, sessionId);
}

function outboundDbPath(agentGroupId, sessionId) {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}

function findSpawnLine(containerName) {
  if (!fs.existsSync(logPath)) {
    return null;
  }
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').reverse();
  return (
    lines.find(
      (line) =>
        line.includes('Spawning container') &&
        line.includes(`containerName="${containerName}"`),
    ) ?? null
  );
}

async function waitForSpawn(existingContainers) {
  const deadline = Date.now() + spawnWaitMs;
  while (Date.now() < deadline) {
    const running = runningContainersForAgent();
    const containerName = running.find((name) => !existingContainers.includes(name));
    if (containerName) {
      return containerName;
    }
    await sleep(250);
  }
  fail(`no spawn observed within ${spawnWaitMs}ms`);
}

async function ensureContainerStable(containerName) {
  const stableDeadline = Date.now() + stableWindowMs;
  while (Date.now() < stableDeadline) {
    if (!runningContainersForAgent().includes(containerName)) {
      fail(`container ${containerName} exited before stable window elapsed`);
    }
    await sleep(250);
  }
}

async function waitForReply(agentGroupId, sessionId, token) {
  const deadline = Date.now() + maxReplyWaitMs;
  const outDb = new Database(outboundDbPath(agentGroupId, sessionId), { readonly: true });
  try {
    while (Date.now() < deadline) {
      const row = outDb
        .prepare(
          `SELECT id, content
           FROM messages_out
           WHERE channel_type = 'cli' AND platform_id = 'local'
           ORDER BY seq DESC
           LIMIT 20`,
        )
        .all()
        .find((entry) => {
          try {
            const content = JSON.parse(entry.content);
            return typeof content.text === 'string' && content.text.includes(token);
          } catch {
            return false;
          }
        });
      if (row) {
        const parsed = JSON.parse(row.content);
        return { id: row.id, text: parsed.text };
      }
      await sleep(250);
    }
  } finally {
    outDb.close();
  }
  fail(`no CLI reply contained ${token} within ${maxReplyWaitMs}ms`);
}

async function dispatchCliMessage(payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(cliSocketPath);

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new Error('CLI dispatch timed out'));
    }, 5000);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
      socket.end();
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function main() {
  if (!fs.existsSync(dbPath)) {
    fail(`DB not found at ${dbPath}`);
  }
  if (!fs.existsSync(cliSocketPath)) {
    fail(`CLI socket not found at ${cliSocketPath}`);
  }

  const db = new Database(dbPath);
  try {
    const session = db
      .prepare(
        `SELECT
           s.id,
           s.agent_group_id,
           s.status,
           s.container_status,
           mg.channel_type,
           mg.platform_id
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
         LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
         WHERE lower(ag.name) = lower(?)
           AND s.status = 'active'
         ORDER BY s.created_at DESC
         LIMIT 1`,
      )
      .get(agentName);

    if (!session) {
      fail(`no active session found for agent ${agentName}`);
    }
    if (session.channel_type !== 'telegram' || !session.platform_id) {
      fail(
        `agent ${agentName} active session is not a Telegram session: ${session.channel_type}/${session.platform_id}`,
      );
    }

    ensureCliDestination(db, session.agent_group_id);

    const token = `SMOKE-${Date.now()}`;
    const payload = {
      text: `Smoke test. Reply with exactly ${token}.`,
      sender: 'cli',
      senderId: 'cli:local',
      to: {
        channelType: session.channel_type,
        platformId: session.platform_id,
        threadId: null,
      },
      reply_to: {
        channelType: 'cli',
        platformId: 'local',
        threadId: null,
      },
    };

    const running = runningContainersForAgent();
    if (running.length > 0) {
      stopRunningContainers(running);
      await sleep(1000);
    }

    await dispatchCliMessage(payload);
    const containerName = await waitForSpawn(running);
    const [{ text: matchingReply }] = await Promise.all([
      waitForReply(session.agent_group_id, session.id, token),
      ensureContainerStable(containerName),
    ]);
    const spawnLine = findSpawnLine(containerName);

    console.log(`SMOKE PASS: ${agentName}`);
    console.log(`session=${session.id}`);
    console.log(`spawn=${containerName}`);
    console.log(`reply=${matchingReply}`);
    console.log(`log=${spawnLine ?? 'not-found'}`);
  } finally {
    db.close();
  }
}

await main();
