-- Corroboration questions waiting in a hub's relay queue for trusted peers nobody can dial: JSON
-- [{url, instance, hub, id, ticket, nonce, queryHash, askedAt}], read on the relay timer until answered.
ALTER TABLE corroboration_retries ADD COLUMN relayed TEXT NOT NULL DEFAULT '[]';
