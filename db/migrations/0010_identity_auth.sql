-- SPDX-License-Identifier: AGPL-3.0-or-later
-- M9 identity & auth: durable accounts (surrogate id) + email magic-link recovery.
-- Additive only — nothing here gates logging yet (that lands with the web sign-in UI). The
-- surrogate account_id makes the callsign a mutable, uniquely-held attribute (rename + re-verify).
-- WebAuthn passkeys reuse the existing `credentials` + `auth_challenges` tables from 0002 (S2).

ALTER TABLE accounts ADD COLUMN account_id TEXT;   -- durable identity (callsign is mutable)
ALTER TABLE accounts ADD COLUMN email TEXT;         -- recovery / magic-link address
UPDATE accounts SET account_id = callsign WHERE account_id IS NULL;  -- backfill existing rows
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON accounts(account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

-- magic-link email tokens (email register / login / recovery)
CREATE TABLE email_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  callsign   TEXT,                 -- desired callsign for a new-account register
  purpose    TEXT NOT NULL,        -- 'register' | 'login'
  created_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- audit of callsign changes (one active callsign per account; re-verify on change)
CREATE TABLE callsign_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,
  set_at     INTEGER NOT NULL,
  verified   INTEGER NOT NULL DEFAULT 0
);
