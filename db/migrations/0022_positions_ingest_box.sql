-- The enrolled box that delivered a position (box_keys.box_id), from its signed request; NULL for a position
-- the shared INGEST_SECRET or any other path stored. A site trusted through a box (box_trusted_sites) attests
-- only the positions that box delivered itself (attestedsites.ts sitesFor).
ALTER TABLE positions ADD COLUMN ingest_box TEXT;

-- "Runs this instance's services" on an enrolled box: the sysop lets it serve the packet BBS mailbox, FBB
-- forwarding, the NET/ROM node mirror, White Pages, federation frames, the APRS-IS outbox and box TX commands.
-- Off by default, and independent of trusting its hearings: a lent receiver never runs them.
ALTER TABLE box_keys ADD COLUMN services INTEGER NOT NULL DEFAULT 0;
