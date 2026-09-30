-- MeshCom as the operator's own node(s) observe it, for the map: the latest state of each node heard, and
-- the links between nodes (direct, or each leg of a relay path) with a smoothed signal report. Display
-- only — nothing here is a trust input. Rows are rewritten only when a shown value changes or at most every
-- MESHCOM_META_MIN_S seconds, and pruned nightly (MESHCOM_NODE_TTL_DAYS, MESHCOM_LINK_TTL_HOURS).
CREATE TABLE meshcom_nodes (
  callsign   TEXT PRIMARY KEY,
  last_heard INTEGER NOT NULL,
  hw_id      INTEGER,
  firmware   TEXT,
  batt       INTEGER,            -- percent
  last_via   TEXT NOT NULL,      -- direct | relayed | server | node (the receiving node's own frames)
  last_rssi  REAL,               -- of the last LoRa hearing, dBm
  last_snr   REAL,               -- dB
  quality    TEXT,               -- strong | usable | weak, from the last LoRa hearing
  receiver   TEXT,               -- the node that received it
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_meshcom_nodes_heard ON meshcom_nodes(last_heard);

CREATE TABLE meshcom_links (
  from_call  TEXT NOT NULL,
  to_call    TEXT NOT NULL,
  kind       TEXT NOT NULL,      -- direct (origin -> receiver) | relay (a leg of a relay path)
  last_seen  INTEGER NOT NULL,
  samples    INTEGER NOT NULL DEFAULT 1,
  rssi_avg   REAL,               -- the leg into the receiver only: rolling average of recent samples
  snr_avg    REAL,
  receiver   TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (from_call, to_call, kind)
);
CREATE INDEX idx_meshcom_links_seen ON meshcom_links(last_seen);
