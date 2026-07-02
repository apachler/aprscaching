-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Federation rendezvous relay queue (docs/design/15 T2.3 path 2). A hub holds relay queries addressed to a
-- NAT'd spoke instance; the spoke leases them over its outbound poll, answers from its own DB, and posts
-- the (signed) result back — reusing the poll-based box-command seam, so it stays tri-runtime-clean.
-- Rows are ephemeral request/response state, TTL'd by the scheduled cleanup. All runtimes.
CREATE TABLE fed_relay_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance    TEXT NOT NULL,                     -- the spoke instance this query is addressed to
  kind        TEXT NOT NULL,                     -- 'feed' | 'corroborate'
  params      TEXT,                              -- JSON query params (e.g. {feed, since})
  status      TEXT NOT NULL DEFAULT 'queued',    -- queued → leased → answered
  answer      TEXT,                              -- JSON RelayResult once the spoke replies
  created_at  INTEGER NOT NULL DEFAULT 0,
  leased_at   INTEGER,
  answered_at INTEGER
);
CREATE INDEX idx_fed_relay_lease ON fed_relay_queue (instance, status, created_at);
