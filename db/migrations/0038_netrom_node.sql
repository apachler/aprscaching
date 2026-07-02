-- SPDX-License-Identifier: AGPL-3.0-or-later
-- NET/ROM node (docs/design/25 P4): the NODES routing table the node advertises + consumes, and a per-port
-- MHeard list (recently-heard stations, the classic node `MH` command). netrom_nodes is keyed by
-- destination (best route per node); node_mheard counts heard calls per radio port. The node CLI +
-- routing brain are pure (@aprsweb/packet); these tables back the read endpoints + sysop admin. All
-- three runtimes.
CREATE TABLE netrom_nodes (
  dest     TEXT PRIMARY KEY,
  alias    TEXT NOT NULL,
  neighbor TEXT NOT NULL,
  quality  INTEGER NOT NULL DEFAULT 100,
  port     TEXT,
  heard_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE node_mheard (
  callsign   TEXT NOT NULL,
  port       TEXT NOT NULL,
  last_heard INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (callsign, port)
);
CREATE INDEX idx_mheard_heard ON node_mheard (last_heard);
