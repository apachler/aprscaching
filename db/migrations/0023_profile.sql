-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Thin, opt-in ham profile. display_name + home_grid already exist (0001); add the rest.
-- All fields are opt-in and self-curated; they live inside the existing GDPR export/erase.
ALTER TABLE accounts ADD COLUMN avatar_url     TEXT;     -- opt-in image URL
ALTER TABLE accounts ADD COLUMN bio            TEXT;     -- short plain text, length-capped + tag-stripped server-side
ALTER TABLE accounts ADD COLUMN links          TEXT;     -- JSON [{label,url}], http(s) only, capped count
ALTER TABLE accounts ADD COLUMN public_contact TEXT;     -- opt-in public email; NULL = not shown (account email stays private)
ALTER TABLE accounts ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 1; -- master show/hide
