-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Owner-gated cache rating (docs/design/26 F-6): a 1–5 star rating, distinct from favourites. The owner
-- chooses WHO may rate via caches.rating_policy: 'finders' (default — only those who logged a verified
-- find), 'all' (any signed-in callsign), or 'off' (disabled). One rating per callsign per cache (an
-- upsert). All three runtimes.
CREATE TABLE cache_ratings (
  cache_id INTEGER NOT NULL,
  callsign TEXT NOT NULL,
  stars    INTEGER NOT NULL,            -- 1..5
  ts       INTEGER NOT NULL,
  PRIMARY KEY (cache_id, callsign)
);
CREATE INDEX idx_cache_ratings_cache ON cache_ratings (cache_id);
ALTER TABLE caches ADD COLUMN rating_policy TEXT NOT NULL DEFAULT 'finders';
