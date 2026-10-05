-- The delivery state of a message an operator sent. `ack` holds the message number it carried, and `acked_at` is
-- when the instance heard the recipient's station acknowledge that number. A message sent through the instance
-- names its APRS-IS outbox row in `outbox_id`; `sent_at` is when the ingest box reported it on APRS-IS. All stay
-- NULL on received messages. The partial indexes serve the ack lookup the ingest runs for each ack it hears and
-- the outbox acknowledgement.
ALTER TABLE messages ADD COLUMN acked_at INTEGER;
ALTER TABLE messages ADD COLUMN outbox_id INTEGER;
ALTER TABLE messages ADD COLUMN sent_at INTEGER;
CREATE INDEX idx_messages_tx_ack ON messages (ack) WHERE direction = 'tx';
CREATE INDEX idx_messages_outbox ON messages (outbox_id) WHERE outbox_id IS NOT NULL;
