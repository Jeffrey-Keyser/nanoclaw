CREATE TABLE IF NOT EXISTS life_prompt_deliveries (
  endpoint TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  destination TEXT NOT NULL,
  prompt_instance_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  source_message_key TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (endpoint, journal_id, credential_fingerprint, destination, prompt_instance_id, part_index)
);

CREATE INDEX IF NOT EXISTS idx_life_prompt_deliveries_scope ON life_prompt_deliveries(endpoint, journal_id, credential_fingerprint, destination, acknowledged);
