-- A passkey belongs to the account that registered it, not to the call string it was registered under:
-- the account keeps its passkeys when its active call changes, and a passkey signs in from any call (or
-- SSID) the account holds. `callsign` stays as the call the passkey was registered under.
ALTER TABLE credentials ADD COLUMN account_id TEXT;
UPDATE credentials SET account_id = (
  SELECT ac.account_id FROM account_callsigns ac
   WHERE ac.callsign = CASE WHEN instr(credentials.callsign, '-') > 0
                            THEN substr(credentials.callsign, 1, instr(credentials.callsign, '-') - 1)
                            ELSE credentials.callsign END
);
CREATE INDEX idx_cred_account ON credentials (account_id);

-- An address given at passkey registration waits here until its owner opens the confirmation link; only
-- a confirmed address (`email`) signs in, receives mail or counts as a way back into the account.
ALTER TABLE accounts ADD COLUMN pending_email TEXT;

-- One account per confirmed address: a magic link names exactly one account.
-- Every writer stores the address lower-cased; the index compares lower-cased too, so a stray capital
-- can never open a second account on the same mailbox.
CREATE UNIQUE INDEX idx_accounts_email_unique ON accounts (lower(email)) WHERE email IS NOT NULL;
