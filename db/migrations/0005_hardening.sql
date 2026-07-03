-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0005 hardening — additive columns/indexes backing the STABILITY-REVIEW fixes. Post-baseline, so
-- self-hosters who already ran 0001–0004 pick these up on the next migrate; a fresh DB gets them too.

-- SR-SEC-07: bind APRS control-verification to the initiating account and rate-limit the 6-digit
-- code. Without these the confirm endpoint was unauthenticated, unthrottled, and used Math.random —
-- ~10^6 unthrottled guesses marked any callsign verified.
ALTER TABLE callsign_verifications ADD COLUMN account_id TEXT;                    -- the account that started the challenge
ALTER TABLE callsign_verifications ADD COLUMN attempts    INTEGER NOT NULL DEFAULT 0;  -- wrong-code guesses; locks after a cap
ALTER TABLE callsign_verifications ADD COLUMN created_at  INTEGER NOT NULL DEFAULT 0;  -- challenge issue time (expiry window)

-- SR-RT-05: the firehose/workbench message log grew unbounded and was scanned without an index
-- (workbench.ts). Index it so the TTL delete and the per-station reads are cheap.
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);
