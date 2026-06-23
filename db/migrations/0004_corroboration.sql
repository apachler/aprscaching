-- 0004: cross-instance verification (F3). Record which peer corroborated a Tier-A find via RF.
ALTER TABLE cache_logs ADD COLUMN corroborated_by TEXT;
