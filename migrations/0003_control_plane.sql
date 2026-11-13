-- The control plane is authoritative in D1. KV remains a derived cache for
-- public subscription reads and backwards compatibility with older deploys.
CREATE TABLE IF NOT EXISTS subscription_control (
  control_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


