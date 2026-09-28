-- SPDX-License-Identifier: AGPL-3.0-or-later
-- What each ingest box can transmit, as it reports on every command poll: whether remote transmit is
-- enabled, whether it has an RF transmitter (KISS TNC), and which MeshCom nodes it can send through. The
-- gateway routes answers to radio commands back through the box that heard them only while the box is
-- polling and able to send; otherwise APRS answers go through the APRS-IS outbox. Kept apart from
-- `boxes`, which records the owning account and exists only once someone has claimed the box.
CREATE TABLE IF NOT EXISTS box_status (
  box_id     TEXT PRIMARY KEY,
  caps       TEXT NOT NULL,               -- JSON {tx: boolean, rf: boolean, meshcom: string[]}
  last_seen  INTEGER NOT NULL
);
