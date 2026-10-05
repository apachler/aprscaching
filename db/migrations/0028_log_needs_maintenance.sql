-- A finder's "needs maintenance" flag on a found or did-not-find log. The cache shows it until its owner posts a
-- maintenance log (or enables the cache again) after it; the owner hears of each flag in the app.
ALTER TABLE cache_logs ADD COLUMN needs_maintenance INTEGER NOT NULL DEFAULT 0;
