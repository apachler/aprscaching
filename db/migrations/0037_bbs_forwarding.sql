-- SPDX-License-Identifier: AGPL-3.0-or-later
-- BBS forwarding + hierarchical routing. bbs_forward_rules is the forward table the
-- ForwardRouter consumes: each row maps a hierarchical route token (or '*' catch-all) to a partner +
-- transport. white_pages steers personal mail by mapping a callsign to its home BBS (FBB WP). The
-- existing bulletin federation is folded in as the default 'ip-fed' catch-all partner. All runtimes.
CREATE TABLE bbs_forward_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  partner    TEXT NOT NULL,
  route      TEXT NOT NULL,                       -- hierarchical token (OE, EU, DB0XYZ…) or '*' catch-all
  transport  TEXT NOT NULL DEFAULT 'ip-fed',      -- ip-fed | rf-fbb | axip
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_fwd_enabled ON bbs_forward_rules (enabled);

CREATE TABLE white_pages (
  callsign   TEXT PRIMARY KEY,
  home_bbs   TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- the live bulletin federation IS the default catch-all forwarding partner
INSERT INTO bbs_forward_rules (partner, route, transport, enabled, created_at) VALUES ('ip-fed', '*', 'ip-fed', 1, 0);
