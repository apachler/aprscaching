-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The id half of a composite (timestamp, id) sync cursor for the feeds whose timestamp can repeat:
-- caches (updated_at) and bulletins (posted_at). A page of records sharing one timestamp is resumed
-- strictly after the last (timestamp, id) pair instead of re-reading the same timestamp forever.
-- NULL means "not known yet": the first pull resumes at the timestamp alone.
ALTER TABLE fed_peers ADD COLUMN caches_cursor_id INTEGER;
ALTER TABLE fed_peers ADD COLUMN bulletins_cursor_id INTEGER;
