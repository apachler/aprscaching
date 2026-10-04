-- What an imported place's source asks to be shown with it. `source_owner` is the author's name at the source
-- (an OpenCaching user name); `source_attribution` is the source's own attribution note, stored as a JSON array
-- of text parts, each with an optional http(s) link, so the cache detail shows it without rendering source HTML.
-- Both stay NULL for native caches and for sources that supply neither.
ALTER TABLE caches ADD COLUMN source_owner TEXT;
ALTER TABLE caches ADD COLUMN source_attribution TEXT;
