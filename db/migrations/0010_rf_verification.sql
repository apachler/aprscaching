-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Callsign control-verification proves control of a licence by a transmission, never by a code read
-- off APRS-IS. The methods are:
--   rf_heard  the holder transmitted `VERIFY <code>` and an attested site heard it on its own radio
--   operator  the instance operator confirmed an ADMIN_CALLSIGNS call with the ingest secret
--   sysop     a sysop verified the call by hand, with a note saying how
-- `verified_by` names who vouched (the attested site, or the sysop's call) and `note` the sysop's reason.
ALTER TABLE callsign_verifications ADD COLUMN verified_by TEXT;
ALTER TABLE callsign_verifications ADD COLUMN note TEXT;

-- A code sent as an APRS message travels over APRS-IS, which anyone can read, so a verification made
-- that way (method `aprs_msg`) proves nothing. Those calls return to unverified, and so does every flag
-- that mirrors them: the held base call, the account's active call, and device keys registered while
-- the call counted as verified. Calls are compared by base call (the part before any SSID).
UPDATE account_callsigns SET verified = 0, method = NULL, verified_at = NULL
 WHERE method = 'aprs_msg'
    OR callsign IN (
      SELECT CASE WHEN instr(callsign, '-') > 0 THEN substr(callsign, 1, instr(callsign, '-') - 1) ELSE callsign END
        FROM callsign_verifications WHERE method = 'aprs_msg' AND status = 'verified');

UPDATE accounts SET verified = 0, verify_method = NULL, verified_at = NULL
 WHERE verify_method = 'aprs_msg'
    OR (CASE WHEN instr(callsign, '-') > 0 THEN substr(callsign, 1, instr(callsign, '-') - 1) ELSE callsign END) IN (
      SELECT CASE WHEN instr(callsign, '-') > 0 THEN substr(callsign, 1, instr(callsign, '-') - 1) ELSE callsign END
        FROM callsign_verifications WHERE method = 'aprs_msg' AND status = 'verified');

UPDATE callsign_keys SET verified = 0
 WHERE verified = 1
   AND (CASE WHEN instr(callsign, '-') > 0 THEN substr(callsign, 1, instr(callsign, '-') - 1) ELSE callsign END) IN (
      SELECT CASE WHEN instr(callsign, '-') > 0 THEN substr(callsign, 1, instr(callsign, '-') - 1) ELSE callsign END
        FROM callsign_verifications WHERE method = 'aprs_msg' AND status = 'verified');

-- Verified and outstanding `aprs_msg` rows alike: the gateway completes no `aprs_msg` challenge.
DELETE FROM callsign_verifications WHERE method = 'aprs_msg';
