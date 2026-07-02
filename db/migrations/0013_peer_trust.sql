-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0012_peer_trust.sql — F4/T1.1: peer trust tiers + quarantine (launch-gating).
--
-- Federation becomes peer-approved by default, open-pull opt-in. Each peer carries a trust level and
-- records inherit their origin peer's trust at read time:
--   • trusted  — operator-curated (FED_PEERS manual peers); counts toward corroboration quorum + map.
--   • unvetted — auto-discovered (FED_DISCOVER); mirrored but FLAGGED — excluded from verification
--                (the corroboration quorum, T1.2) and from the default map until promoted.
--   • blocked  — never fetched (sync or corroborate).
-- Reputation counters feed operator promote/demote (auto-promotion past a threshold lands later).
ALTER TABLE fed_peers ADD COLUMN trust         TEXT    NOT NULL DEFAULT 'unvetted'; -- trusted | unvetted | blocked
ALTER TABLE fed_peers ADD COLUMN added_via     TEXT;                                -- manual | discovered
ALTER TABLE fed_peers ADD COLUMN approved_at   INTEGER;                             -- unix-seconds an operator trusted it
ALTER TABLE fed_peers ADD COLUMN rep_confirmed INTEGER NOT NULL DEFAULT 0;          -- corroborations later confirmed
ALTER TABLE fed_peers ADD COLUMN rep_failed    INTEGER NOT NULL DEFAULT 0;          -- corroborations contradicted
