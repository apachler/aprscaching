-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Raw per-station packet history for the workbench (docs/design/26 Stage 0.2). A short, hard-TTL ring of the
-- raw TNC2 frames we've heard, so an operator can inspect a station's recent traffic verbatim. This is
-- a workbench-only diagnostic, NOT a long-term log — pruned aggressively by the scheduled job (cost
-- rule: persist selectively + TTL). Keyed for "latest N for this callsign" reads.
CREATE TABLE packets_recent (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign  TEXT NOT NULL,            -- the source station (src)
  ts        INTEGER NOT NULL,
  dst       TEXT,
  path      TEXT,                     -- comma-joined digi path
  payload   TEXT,                     -- the information field, verbatim
  heard_via TEXT,                     -- rf | aprs_is
  port      TEXT
);
CREATE INDEX idx_packets_recent_cs ON packets_recent (callsign, ts);
CREATE INDEX idx_packets_recent_ts ON packets_recent (ts);
