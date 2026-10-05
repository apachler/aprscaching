-- Read-API keys belong to a signed-in account. The instance stores only the SHA-256 of each key, so a copy of the
-- database holds no usable key; `prefix` is the key's first characters, enough for the owner and the sysop to
-- tell keys apart. A key raises the read API's rate limit and gates nothing.
DROP INDEX IF EXISTS idx_api_keys_owner;
DROP TABLE api_keys;
CREATE TABLE api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash     TEXT NOT NULL UNIQUE,                -- hex SHA-256 of the full key
  prefix       TEXT NOT NULL,                       -- the key's first 12 characters, shown in lists
  account_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  rate_tier    TEXT NOT NULL DEFAULT 'free',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_api_keys_account ON api_keys (account_id);
