-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0002_auth_announce.sql
-- Auth layer (passkey identity + async callsign-control badge) and the APRS-IS announce outbox.

-------------------------------------------------- IDENTITY: passkeys (WebAuthn)
CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,        -- credential ID (base64url)
  callsign    TEXT NOT NULL,
  public_key  BLOB NOT NULL,
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_cred_callsign ON credentials(callsign);

-- short-lived challenges for passkey ceremonies AND magic-links / APRS codes
CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,
  callsign    TEXT,
  kind        TEXT NOT NULL,           -- webauthn_reg | webauthn_login | magic | aprs_code
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

------------------------------------- CALLSIGN-CONTROL VERIFICATION (the badge)
-- Async; NEVER blocks logging. Gates the APRS-IS announce feature + competitive credit.
CREATE TABLE callsign_verifications (
  callsign    TEXT PRIMARY KEY,
  method      TEXT,                    -- aprs_msg | aprs_tx | lotw | qrz | external
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | verified | failed
  challenge   TEXT,                    -- one-time code we sent / token to TX
  verified_at INTEGER
);

-------------------------------------------------- ACCOUNT FLAGS (added to 0001)
ALTER TABLE accounts ADD COLUMN announce_is INTEGER NOT NULL DEFAULT 0; -- opt-in: publish finds to APRS-IS
ALTER TABLE accounts ADD COLUMN announce_tocall TEXT DEFAULT 'APZACG';  -- experimental tocall until registered

------------------------------------------------------------ APRS-IS OUTBOX
-- Worker enqueues; the ingest box (only holder of the APRS-IS uplink) publishes via
-- third-party format. Excluded from verification by construction (status, not position).
CREATE TABLE aprs_outbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  src_call  TEXT NOT NULL,             -- the user's VERIFIED callsign (inner source)
  tocall    TEXT NOT NULL DEFAULT 'APZACG',
  kind      TEXT NOT NULL,             -- status | message
  payload   TEXT NOT NULL,             -- e.g. ">Found AC-1234 (Reutersley) via aprscaching.com"
  status    TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  sent_at   INTEGER
);
CREATE INDEX idx_outbox_status ON aprs_outbox(status, ts);
