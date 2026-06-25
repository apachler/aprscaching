-- Multiple verified base calls per account (the ham-correct identity model, docs/10 §19).
-- An account (person) is not one callsign: it holds one or more *base* callsigns, each verified
-- independently (the APRS message-challenge proves control of the license = the base call). The
-- active operating callsign (accounts.callsign) is just whichever held call the session is bound to.
-- Switching between held calls must NOT re-verify; only adding a new base call does.
--
-- Additive only. accounts.callsign stays the active-call anchor; account_id stays the durable id.
-- credentials/passkeys stay bound to the account's primary call (login is by the primary call),
-- so switching the active call no longer moves credentials.

CREATE TABLE IF NOT EXISTS account_callsigns (
  account_id  TEXT NOT NULL,             -- durable account (accounts.account_id)
  callsign    TEXT NOT NULL,             -- BASE call only (no SSID); the license
  verified    INTEGER NOT NULL DEFAULT 0,
  method      TEXT,                       -- 'aprs_msg' | 'lotw' | …
  verified_at INTEGER,
  is_primary  INTEGER NOT NULL DEFAULT 0, -- the call the passkey/credentials are bound to
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, callsign)
);
-- a base call is held by at most one account (prevents two accounts claiming the same license)
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_callsigns_call ON account_callsigns(callsign);

-- backfill: each existing account's current callsign becomes its primary held base call,
-- inheriting that account's current verification state.
INSERT OR IGNORE INTO account_callsigns (account_id, callsign, verified, method, verified_at, is_primary, added_at)
  SELECT account_id, callsign, verified, verify_method, verified_at, 1, COALESCE(created_at, 0)
  FROM accounts WHERE account_id IS NOT NULL;
