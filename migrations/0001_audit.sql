CREATE TABLE IF NOT EXISTS refresh_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  valid_count INTEGER NOT NULL,
  content_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_audit_created_at
  ON refresh_audit (created_at DESC);

