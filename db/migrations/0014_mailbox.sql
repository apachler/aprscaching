-- The Mailbox: a short message held for a callsign until its station is heard, then sent to it as an APRS
-- message from the service call. Separate from the BBS, which moves its mail the F6FBB way only.
CREATE TABLE mailbox_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_call    TEXT NOT NULL,                      -- the sender's verified call, as it signs the message
  from_account TEXT NOT NULL,                      -- the account holding that call
  to_call      TEXT NOT NULL,                      -- a base call (any SSID of it) or one station's call
  body         TEXT NOT NULL,
  via          TEXT NOT NULL,                      -- app | radio
  status       TEXT NOT NULL DEFAULT 'held',       -- held | sent | delivered | undelivered | expired
  delivered_to TEXT,                               -- the station it was sent to
  msg_no       TEXT,                               -- its APRS message number on the air
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_mailbox_to ON mailbox_messages (to_call, status);
CREATE INDEX idx_mailbox_waiting ON mailbox_messages (status, expires_at);
CREATE INDEX idx_mailbox_from ON mailbox_messages (from_account, created_at);
