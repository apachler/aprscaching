-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0004: cross-instance verification (F3). Record which peer corroborated a Tier-A find via RF.
ALTER TABLE cache_logs ADD COLUMN corroborated_by TEXT;
