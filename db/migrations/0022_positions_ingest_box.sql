-- The enrolled box that delivered a position (box_keys.box_id), from its signed request; NULL for a position
-- the shared INGEST_SECRET or any other path stored. A site trusted through a box (box_trusted_sites) attests
-- only the positions that box delivered itself (attestedsites.ts sitesFor).
ALTER TABLE positions ADD COLUMN ingest_box TEXT;
