-- Durable status and captured results for provider-neutral agent events.

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  execution_jid TEXT NOT NULL,
  source TEXT NOT NULL,
  delivery_mode TEXT NOT NULL DEFAULT 'channel'
    CHECK (delivery_mode IN ('channel', 'capture')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  execution_id TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_events_execution_status
  ON agent_events(execution_jid, status, created_at);
