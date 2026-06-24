-- BBS store-and-forward message base (Stage 1: connectionless / APRS-message delivery).
-- Personal mail is held until the addressee is heard, then forwarded as an APRS message with
-- ack tracking + retry. Bulletins are retrievable and deduped by BID across forwarding. The
-- format (P/B type, BID) is MBL/FBB-compatible so a future connected-mode gateway can bridge.
CREATE TABLE bbs_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bid        TEXT UNIQUE,                       -- e.g. "42_oe.aprscaching.org" — dedup across peers
  type       TEXT NOT NULL,                     -- 'P' personal | 'B' bulletin
  from_call  TEXT NOT NULL,
  to_call    TEXT NOT NULL,                     -- callsign (P) or category e.g. ALL / SYSOP (B)
  subject    TEXT,
  body       TEXT NOT NULL,
  posted_at  INTEGER NOT NULL,
  expires_at INTEGER,
  origin     TEXT NOT NULL DEFAULT 'local',     -- 'local' or the instance id a bulletin forwarded from
  read_at    INTEGER                            -- personal: when the recipient read it (web)
);
CREATE INDEX idx_bbs_to ON bbs_messages(to_call, type, posted_at DESC);

-- Per-recipient delivery state for the store-and-forward (APRS) path.
CREATE TABLE bbs_delivery (
  msg_id       INTEGER NOT NULL,
  to_call      TEXT NOT NULL,
  line_no      INTEGER,                          -- the APRS message number {NN used on the wire
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  acked_at     INTEGER,
  status       TEXT NOT NULL DEFAULT 'held',     -- held | sent | acked | expired
  PRIMARY KEY (msg_id, to_call)
);
CREATE INDEX idx_bbs_delivery_call ON bbs_delivery(to_call, status);
