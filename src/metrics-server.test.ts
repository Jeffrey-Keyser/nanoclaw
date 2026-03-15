import http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  logContainerMetric,
  logTaskRun,
  createTask,
} from './db.js';
import { startMetricsServer } from './metrics-server.js';

let server: http.Server;
let port: number;

function fetch(
  path: string,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  _initTestDatabase();
  // Use port 0 to let the OS pick a free port
  server = await startMetricsServer(0, '127.0.0.1');
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(() => {
  server.close();
});

describe('metrics server', () => {
  it('returns 200 with valid JSON on GET /metrics', async () => {
    const { status, body } = await fetch('/metrics');
    expect(status).toBe(200);

    const data = JSON.parse(body);
    expect(data).toHaveProperty('generated_at');
    expect(data).toHaveProperty('window_hours', 24);
    expect(data).toHaveProperty('containers');
    expect(data).toHaveProperty('tasks');
    expect(Array.isArray(data.containers)).toBe(true);
    expect(Array.isArray(data.tasks)).toBe(true);
  });

  it('returns container metrics in the response', async () => {
    logContainerMetric({
      group_folder: 'main',
      container_name: 'nanoclaw-main-1',
      started_at: new Date().toISOString(),
      startup_time_ms: 1500,
      duration_ms: 30000,
      exit_code: 0,
      timed_out: false,
      status: 'success',
    });

    const { body } = await fetch('/metrics');
    const data = JSON.parse(body);
    expect(data.containers).toHaveLength(1);
    expect(data.containers[0].group_folder).toBe('main');
    expect(data.containers[0].total_spawns).toBe(1);
  });

  it('returns task metrics in the response', async () => {
    createTask({
      id: 'srv-task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    logTaskRun({
      task_id: 'srv-task-1',
      run_at: new Date().toISOString(),
      duration_ms: 5000,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const { body } = await fetch('/metrics');
    const data = JSON.parse(body);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].task_id).toBe('srv-task-1');
    expect(data.tasks[0].success_count).toBe(1);
  });

  it('returns 404 for unknown paths', async () => {
    const { status } = await fetch('/unknown');
    expect(status).toBe(404);
  });
});
