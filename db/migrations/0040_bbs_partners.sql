-- SPDX-License-Identifier: AGPL-3.0-or-later
-- FBB forwarding partners. Per-partner config the ingest forwarding scheduler consumes:
-- who to connect to, how to reach them (connect script through nodes), when (interval + UTC time-bands),
-- and what to exchange (msgtypes, block/size caps, reverse-forward). This extends bbs_forward_rules
-- (route → partner) with the partner's *transport-level* settings; a rule names a partner, a partner row
-- says how to actually forward to it. Sysop-configured; RF delivery is validate-at-deploy. All runtimes.
CREATE TABLE bbs_partners (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  call            TEXT NOT NULL UNIQUE,               -- partner BBS callsign (SSID-bearing, uppercased)
  ha              TEXT,                               -- partner's hierarchical address (e.g. OE8XBM.OE.EU)
  connect_script  TEXT NOT NULL DEFAULT '',           -- how to reach it: "C NODE1" / "C 3 DB0XYZ" lines (\n-sep)
  proto           TEXT NOT NULL DEFAULT 'rf-fbb',      -- rf-fbb | axudp | ip-fed
  interval_min    INTEGER NOT NULL DEFAULT 30,         -- forwarding poll interval, minutes (0 = manual only)
  timebands       TEXT NOT NULL DEFAULT '',            -- UTC hour windows "0-6,22-23" ('' = any time)
  request_reverse INTEGER NOT NULL DEFAULT 1,          -- ask the partner to reverse-forward to us
  msgtypes        TEXT NOT NULL DEFAULT 'PBT',         -- which types we send: subset of P(ersonal) B(ulletin) T(raffic)
  max_block       INTEGER NOT NULL DEFAULT 5,          -- proposals per FBB block (spec cap = 5)
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_partners_enabled ON bbs_partners (enabled);
