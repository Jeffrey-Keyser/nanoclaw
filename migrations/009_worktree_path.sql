-- Add worktree_path to dispatch_slots for per-dispatch git worktree isolation.
-- Each parallel dispatch creates an isolated git worktree; the path is recorded
-- here so it can be cleaned up on slot free or startup reconciliation.
-- Note: SQLite does not support IF NOT EXISTS on ALTER TABLE, but the migration
-- framework tracks applied versions and will not re-run this migration.
ALTER TABLE dispatch_slots ADD COLUMN worktree_path TEXT;
