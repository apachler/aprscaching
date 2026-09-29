-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A session names the durable account behind it and that account's session generation. Bumping
-- `session_gen` ends every session the account holds: signing out everywhere, changing the active
-- call, and erasure (which removes the row outright) all rely on it.
ALTER TABLE accounts ADD COLUMN session_gen INTEGER NOT NULL DEFAULT 0;

-- Every account row carries a durable id, so a session can bind to it. A migrated-in account is the
-- only kind created without one.
UPDATE accounts SET account_id = lower(hex(randomblob(16))) WHERE account_id IS NULL;

-- A remote box is linked to an account only by a one-time pairing code the box itself obtains with its
-- ingest secret and shows to its operator. Only a hash of the code is kept, and only until it expires or
-- is used.
CREATE TABLE IF NOT EXISTS box_pairings (
  box_id     TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,   -- SHA-256 hex of the normalised code
  expires_at INTEGER NOT NULL
);
