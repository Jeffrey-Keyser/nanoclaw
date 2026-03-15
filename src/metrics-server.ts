/**
 * Lightweight HTTP metrics endpoint for NanoClaw.
 * Exposes GET /metrics with aggregated container and task stats.
 */
import { createServer, Server } from 'http';

import { getContainerHealthSummary, getTaskMetricsSummary } from './db.js';
import { logger } from './logger.js';

export const METRICS_PORT = parseInt(process.env.METRICS_PORT || '3002', 10);

export function startMetricsServer(
  port: number = METRICS_PORT,
  host: string = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/metrics') {
        try {
          const containerStats = getContainerHealthSummary(24);
          const taskStats = getTaskMetricsSummary(24);

          const payload = {
            generated_at: new Date().toISOString(),
            window_hours: 24,
            containers: containerStats,
            tasks: taskStats,
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload, null, 2));
        } catch (err) {
          logger.error({ err }, 'Metrics endpoint error');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Metrics server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
