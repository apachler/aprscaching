-- Imported places the sysop removed, at the request of the source or of the listing's owner. A re-import skips
-- every (source, external_id) listed here, so a removed listing does not come back. A row names the listing
-- only: no person, no account.
CREATE TABLE import_removals (
  source      TEXT NOT NULL,                       -- opencaching | sota | pota | …
  external_id TEXT NOT NULL,                       -- the listing's id at the source
  code        TEXT,                                -- the code the place carried here
  note        TEXT,                                -- why it was removed, as the sysop put it
  removed_at  INTEGER NOT NULL,
  PRIMARY KEY (source, external_id)
);
