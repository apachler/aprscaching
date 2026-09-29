-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One store per fact.
--
-- Whether control of a licence is proven lives only in `callsign_verifications`, keyed by base call
-- (status 'verified'). The held call, the account row and device keys carried copies of it; those
-- columns go, and every reader derives the flag from the store.
--
-- Who holds a licence lives only in `account_callsigns` (one holder per base call). Every account holds
-- the base call of its active call there.

-- A claim starts unverified: a verification recorded while nobody held the call never reached the
-- account that later claimed it (its held-call flag stayed unset). Such rows leave the store, so the
-- store says what the held-call flag said.
DELETE FROM callsign_verifications
 WHERE status = 'verified'
   AND callsign IN (SELECT callsign FROM account_callsigns WHERE verified = 0);

-- Every account holds its base call. An account without a held-call row gets its active call's base as
-- its primary, unless another account already holds that base: a row naming someone else's licence
-- stays without one and resolves to nobody. The oldest account wins when two name the same base.
INSERT OR IGNORE INTO account_callsigns (account_id, callsign, is_primary, added_at)
SELECT a.account_id,
       CASE WHEN instr(a.callsign, '-') > 0 THEN substr(a.callsign, 1, instr(a.callsign, '-') - 1) ELSE a.callsign END,
       1,
       a.created_at
  FROM accounts a
 WHERE a.account_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM account_callsigns ac WHERE ac.account_id = a.account_id)
 ORDER BY a.created_at, a.callsign;

-- The copies of the verification flag. No index, trigger or view names these columns.
ALTER TABLE accounts DROP COLUMN verified;
ALTER TABLE accounts DROP COLUMN verify_method;
ALTER TABLE accounts DROP COLUMN verified_at;
ALTER TABLE account_callsigns DROP COLUMN verified;
ALTER TABLE account_callsigns DROP COLUMN method;
ALTER TABLE account_callsigns DROP COLUMN verified_at;
ALTER TABLE callsign_keys DROP COLUMN verified;
