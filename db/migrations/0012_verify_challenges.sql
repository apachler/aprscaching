-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Challenges of the callsign control-verification methods that complete in the browser session rather
-- than on the air: `ampr_dns` (a code published in the holder's ampr.org DNS) and `lotw` (a nonce signed
-- with the holder's LoTW callsign-certificate key). One outstanding challenge per base call and method,
-- bound to the account that started it; the on-air `rf_heard` challenge lives in callsign_verifications.
CREATE TABLE callsign_challenges (
  callsign   TEXT NOT NULL,              -- base call
  method     TEXT NOT NULL,              -- ampr_dns | lotw
  account_id TEXT NOT NULL,
  challenge  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0, -- failed completions; the challenge locks at the cap
  created_at INTEGER NOT NULL,
  PRIMARY KEY (callsign, method)
);
CREATE INDEX idx_callsign_challenges_account ON callsign_challenges (account_id);
