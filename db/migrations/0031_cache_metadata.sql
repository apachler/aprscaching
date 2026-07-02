-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cache metadata from the original APRSCaching concept (docs/26 F-8): a car-accessible "Drive-In"
-- flag, a country, and free-form tags. All additive/optional; tags are stored comma-joined (the
-- gateway dedupes + lowercases). Country is owner-set (a coordinate-derived default can follow once a
-- geocoder is wired). All three runtimes (D1 / better-sqlite3 / bun).
ALTER TABLE caches ADD COLUMN drive_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE caches ADD COLUMN country  TEXT;
ALTER TABLE caches ADD COLUMN tags     TEXT;   -- comma-joined free tags
