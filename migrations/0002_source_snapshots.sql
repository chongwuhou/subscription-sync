CREATE TABLE IF NOT EXISTS source_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  valid_count INTEGER NOT NULL,
  nodes_json TEXT NOT NULL,
  UNIQUE (subscription_id, source_content_hash)
);

CREATE INDEX IF NOT EXISTS idx_source_snapshots_latest
  ON source_snapshots (subscription_id, captured_at DESC, id DESC);

