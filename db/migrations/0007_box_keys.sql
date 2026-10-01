-- Ingest boxes enrolled with a one-time code. Each holds its own Ed25519 key and signs every request to
-- the gateway with it, so one box is revoked without rotating the shared INGEST_SECRET of every other box.
-- An enrolled box has the ingest plane's rights and nothing more; whether what it hears counts for Tier A
-- still depends only on FIRST_PARTY_SITES.

-- A code the sysop creates in Instance admin, shown once. Only its SHA-256 is kept; it is good for one
-- enrollment until it expires. The row stays as the record of who let which box in.
CREATE TABLE box_enrollment_codes (
  code_hash  TEXT PRIMARY KEY,                     -- SHA-256 hex of the normalised code
  label      TEXT,                                 -- the box name the sysop gave it
  callsign   TEXT,                                 -- optional base call the box may name as its receiving site
  created_by TEXT NOT NULL,                        -- the sysop's account id, or 'operator' (OPERATOR_SECRET)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  box_id     TEXT                                  -- the box it enrolled
);

-- An enrolled box's public key, with who enrolled and who revoked it. A revoked key never verifies again;
-- the box enrolls anew with a fresh code and key.
CREATE TABLE box_keys (
  box_id       TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL UNIQUE,               -- raw Ed25519, base64url
  label        TEXT,
  callsign     TEXT,
  enrolled_by  TEXT NOT NULL,
  enrolled_at  INTEGER NOT NULL,
  revoked_by   TEXT,
  revoked_at   INTEGER,
  last_seen_at INTEGER                             -- refreshed at most every five minutes
);
