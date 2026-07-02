-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0005: per-callsign signing (F0). Device keys bound to callsigns; finds carry the logger's signature.

CREATE TABLE callsign_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign   TEXT NOT NULL,
  public_key TEXT NOT NULL,               -- Ed25519 raw, base64url
  label      TEXT,
  verified   INTEGER NOT NULL DEFAULT 0,  -- callsign badge-verified at registration time
  created_at INTEGER NOT NULL,
  UNIQUE (callsign, public_key)
);
CREATE INDEX idx_callsign_keys_call ON callsign_keys(callsign);

-- a find may be signed by the logger's device key (provenance, portable across instances)
ALTER TABLE cache_logs ADD COLUMN signer_key TEXT;   -- the device public key (base64url)
ALTER TABLE cache_logs ADD COLUMN author_sig TEXT;   -- signature over authorshipMessage(...)
ALTER TABLE cache_logs ADD COLUMN signed_at  INTEGER;-- client authorship time the signature covers

-- mirrored key bindings from peers (so consumers can check author signatures offline)
CREATE TABLE remote_keys (
  global_id   TEXT PRIMARY KEY,           -- origin:key:rowid
  origin      TEXT NOT NULL,
  callsign    TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  verified    INTEGER, created_at INTEGER, mirrored_at INTEGER NOT NULL
);
CREATE INDEX idx_remote_keys_call ON remote_keys(callsign);

-- per-feed cursor for the keys feed
ALTER TABLE fed_peers ADD COLUMN keys_cursor INTEGER NOT NULL DEFAULT 0;
