-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Save / share map views: a permalink short-link that restores a map state
-- (centre/zoom/layers/filters/selection). Public by default — the point is to share a link.
CREATE TABLE IF NOT EXISTS saved_views (
  slug       TEXT PRIMARY KEY,
  owner_call TEXT,
  name       TEXT,
  state      TEXT NOT NULL,                 -- JSON: { center, zoom, layers, filters, selected }
  public     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_views_owner ON saved_views (owner_call);
