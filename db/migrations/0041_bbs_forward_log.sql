-- SPDX-License-Identifier: AGPL-3.0-or-later
-- FBB forwarding log. Tracks which message BIDs have already been forwarded to which
-- partner so the ingest forwarding scheduler never re-offers the same message on the next session
-- (the FBB BID dedup handles the *inbound* side; this is the *outbound* per-partner memory). All runtimes.
CREATE TABLE bbs_forward_log (
  partner      TEXT NOT NULL,                    -- partner BBS callsign (bbs_partners.call)
  bid          TEXT NOT NULL,                    -- the forwarded message's BID
  forwarded_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner, bid)
);
