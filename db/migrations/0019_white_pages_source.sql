-- Where a White Pages entry came from: `manual` is set by the operator and steers mail until the operator
-- changes it; `learned` comes from the R: header of forwarded mail and never replaces a manual entry.
ALTER TABLE white_pages ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'learned'));
