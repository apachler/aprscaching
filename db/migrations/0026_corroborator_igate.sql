-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cross-instance corroborator credit. Persist the IGate that corroborated each
-- Tier-A find directly on the log, so the corroborator leaderboard credits the operator who actually
-- did the RF corroboration — whether it happened on THIS instance (the matched position's gating
-- IGate) or on a federated peer that revealed its IGate (FED_REVEAL_IGATE, both-opt-in). Peer-
-- corroborated finds previously had no matched_position_id and so earned no IGate credit.
ALTER TABLE cache_logs ADD COLUMN corroborator_igate TEXT;

-- Backfill existing local Tier-A finds from their matched RF position's gating IGate.
UPDATE cache_logs SET corroborator_igate = (
  SELECT p.igate_call FROM positions p WHERE p.id = cache_logs.matched_position_id
)
WHERE tier = 'A' AND verified = 1 AND matched_position_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_logs_corroborator ON cache_logs (corroborator_igate);
