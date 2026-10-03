-- How each message reached the instance, or left it: the transport positions record (provenance.ts), so the
-- Messages list can say which network carried it. NULL on a row stored without one.
ALTER TABLE messages ADD COLUMN transport TEXT;

-- MeshCom group chat (a message to a group number, or `*` to all), as the operator's own node(s) heard it.
-- Read-only display data, never a trust input. One row per message, however many nodes or paths delivered
-- it: dedup_key is the sender and its MeshCom msg_id (sender, group, text and a ten-minute bucket when the
-- frame carries none). A later, better hearing (direct over relayed, LoRa over the MeshCom server) replaces
-- `heard` and `receiver`. Pruned nightly with the message log (RETENTION messagesDays).
CREATE TABLE meshcom_group_messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  from_call TEXT NOT NULL,
  grp       TEXT NOT NULL,                         -- the group number, or * for all
  body      TEXT NOT NULL,
  msg_id    TEXT,                                  -- the MeshCom msg_id, hex
  receiver  TEXT,                                  -- the node that heard it
  heard     TEXT,                                  -- direct | relayed | server | node
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_meshcom_group_messages_grp ON meshcom_group_messages (grp, ts, id);
CREATE INDEX idx_meshcom_group_messages_ts ON meshcom_group_messages (ts);
CREATE INDEX idx_meshcom_group_messages_from ON meshcom_group_messages (from_call);
