-- Remote station control (docs/20 §2, R1): a per-box command queue the operator's ingest box pulls
-- over its existing outbound connection (no inbound ports). TX-capable commands are control-verified
-- (H5, docs/19); RX-only boxes only ever receive read commands. Distinct from federation peer identity.
CREATE TABLE IF NOT EXISTS box_commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id     TEXT NOT NULL,
  callsign   TEXT,                              -- licensed call the command operates as (TX → must be verified)
  kind       TEXT NOT NULL,                     -- beacon | message | wx_beacon | igate | digi | tx | status
  payload    TEXT,                              -- JSON command args
  status     TEXT NOT NULL DEFAULT 'queued',    -- queued | sent | done | failed
  result     TEXT,                              -- box-reported result/error
  sig        TEXT,                              -- optional Ed25519 signature for the licensed call (box-verified)
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  acked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_box_commands_poll ON box_commands (box_id, status, created_at);
