-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Supporter recognition + transparency ledger (docs/12 M4). RECOGNITION ONLY — never a feature gate.
-- (Migration number pinned to 0012 per docs/14; lands after 0011_account_callsigns, fills the
--  reserved gap. The migrator applies by filename, so this is safe to add after later migrations.)

-- accounts.tier is a thank-you level (free | supporter); hide_nag suppresses the support prompt.
-- NO core handler may read tier/entitlements to RESTRICT anything — donations unlock nothing functional.
ALTER TABLE accounts ADD COLUMN tier     TEXT    NOT NULL DEFAULT 'free';
ALTER TABLE accounts ADD COLUMN hide_nag INTEGER NOT NULL DEFAULT 0;

-- Public transparency ledger (docs/12 §2): what came in and how it was spent, per bucket.
CREATE TABLE IF NOT EXISTS ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  direction    TEXT NOT NULL,            -- in | out
  bucket       TEXT NOT NULL,            -- development | hosting | operation | peer_reimbursement
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'EUR',
  note         TEXT,
  source       TEXT                      -- liberapay | kofi | patreon | opencollective | manual
);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger (ts);

-- Recognition entitlements ONLY (reserved seam) — keyed recognition flags, never functional limits.
-- The M4 badge + hide-nag use accounts.tier/hide_nag directly; this is for future recognition keys.
CREATE TABLE IF NOT EXISTS entitlements (
  account_id TEXT NOT NULL,
  key        TEXT NOT NULL,             -- supporter_badge | … (recognition only)
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);
