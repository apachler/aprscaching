-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Taking over a held call by proof of control, and the trail of every change of a call's holder.
--
-- A call held by an account that never proved control of it is not that account's for good: its licensee may
-- open a claim and complete any control-verification method for the call. The claim carries a bearer token
-- (stored only as its hash) so a person without an account can claim their own call at sign-up; a signed-in
-- claimant's account is named on the claim. On success the call moves to the claimant, verified.

CREATE TABLE callsign_claims (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,              -- SHA-256 (base64url) of the claimant's bearer token
  callsign      TEXT NOT NULL,                     -- base call
  account_id    TEXT,                              -- the claimant's account; a sign-up claim names the new one on success
  signup        INTEGER NOT NULL DEFAULT 0,        -- opened without an account: success opens one
  holder_id     TEXT,                              -- the account that held the call when the claim opened (NULL: nobody)
  status        TEXT NOT NULL DEFAULT 'open',      -- open | done | refused
  -- the on-air code of the claim, kept apart from the holder's own challenge so neither replaces the other
  rf_code       TEXT,
  rf_attempts   INTEGER NOT NULL DEFAULT 0,
  rf_created_at INTEGER,
  method        TEXT,                              -- the verification method that completed the claim
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  collected     INTEGER NOT NULL DEFAULT 0         -- a sign-up claim's session was handed out
);
CREATE INDEX idx_callsign_claims_call ON callsign_claims (callsign, status);
CREATE INDEX idx_callsign_claims_account ON callsign_claims (account_id);

-- Who held a call, and when that changed outside the account's own hands: a claim by proof of control, or a
-- sysop releasing the call from an account. `actor` is the verification method of a claim or the sysop's call.
CREATE TABLE callsign_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign     TEXT NOT NULL,                      -- base call
  action       TEXT NOT NULL,                      -- claimed | released
  from_account TEXT,                               -- the account that lost the call (NULL: nobody held it)
  to_account   TEXT,                               -- the account that took it (NULL on a release)
  actor        TEXT NOT NULL,
  note         TEXT,                               -- the sysop's reason for a release
  at           INTEGER NOT NULL
);
CREATE INDEX idx_callsign_events_call ON callsign_events (callsign, id);
CREATE INDEX idx_callsign_events_from ON callsign_events (from_account);
CREATE INDEX idx_callsign_events_to ON callsign_events (to_account);

-- A browser-session challenge (ampr_dns, lotw) is one per base call, method and starter, so a claimant's
-- challenge and the holder's never replace each other.
CREATE TABLE callsign_challenges_next (
  callsign   TEXT NOT NULL,                        -- base call
  method     TEXT NOT NULL,                        -- ampr_dns | lotw
  account_id TEXT NOT NULL,                        -- the starting account, or `claim:<id>` for a claim
  challenge  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,           -- failed completions; the challenge locks at the cap
  created_at INTEGER NOT NULL,
  PRIMARY KEY (callsign, method, account_id)
);
INSERT INTO callsign_challenges_next (callsign, method, account_id, challenge, attempts, created_at)
  SELECT callsign, method, account_id, challenge, attempts, created_at FROM callsign_challenges;
DROP TABLE callsign_challenges;
ALTER TABLE callsign_challenges_next RENAME TO callsign_challenges;
CREATE INDEX idx_callsign_challenges_account ON callsign_challenges (account_id);
