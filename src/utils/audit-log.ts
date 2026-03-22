import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';

const AUDIT_DIR = path.join(os.homedir(), '.local', 'share', 'nanoclaw');

export interface AuditEntry {
  timestamp: string;
  auditId: string;
  requestedBy: string;
  command: string;
  args: string[];
  reason: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function auditLogPath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(AUDIT_DIR, `host-exec-audit-${date}.jsonl`);
}

export function appendAuditLog(entry: AuditEntry): void {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(auditLogPath(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    logger.error({ err }, 'audit-log: failed to write audit entry');
  }
}

export function makeAuditId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
