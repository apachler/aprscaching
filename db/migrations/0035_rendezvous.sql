-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Living-cache rendezvous (docs/design/26 F-4): in the original APRSCaching, two *living* caches (beaconing
-- stations that ARE caches) who meet both log each other — a deliberately social "make new
-- acquaintances" mechanic. Opt-in per living cache (caches.rendezvous). A meeting is recorded when two
-- opted-in living caches are co-located and both beaconed within a short window. This is a SOCIAL
-- record, deliberately kept OUT of the A/B/C verified-find tiers (two colluding stations must not be
-- able to farm verified finds by parking together). All three runtimes.
ALTER TABLE caches ADD COLUMN rendezvous INTEGER NOT NULL DEFAULT 0;

CREATE TABLE rendezvous_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_a  INTEGER NOT NULL,   -- the living cache that just beaconed
  cache_b  INTEGER NOT NULL,   -- the co-located living cache it met
  call_a   TEXT NOT NULL,
  call_b   TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  lat      REAL,
  lon      REAL
);
CREATE INDEX idx_rendezvous_a ON rendezvous_log (cache_a, ts);
CREATE INDEX idx_rendezvous_b ON rendezvous_log (cache_b, ts);
