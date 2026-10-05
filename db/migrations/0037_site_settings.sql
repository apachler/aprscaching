-- Site settings: the policy values the sysop sets in Instance admin → Instance settings (sitesettings.ts). A row
-- holds the value as it is stored, already checked against the configuration schema; a key the environment sets
-- wins over its row, and a key with no row takes the schema default. Resetting a setting deletes its row. The
-- change history is the moderation audit log.
CREATE TABLE site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL                          -- the sysop's call, or OPERATOR for a scripted change
);
