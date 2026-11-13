-- Keep large source snapshots below D1 row limits while retaining the full
-- validated node list for historical fallback and manual version selection.
CREATE TABLE IF NOT EXISTS source_snapshot_chunks (
  snapshot_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_source_snapshot_chunks_snapshot
  ON source_snapshot_chunks (snapshot_id, chunk_index);

