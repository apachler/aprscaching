-- The region a peer's caches cursor was read under (FED_SYNC_REGION, normalised; '' for the whole feed).
-- A cursor means "everything up to here" only for the filter it was read with, so a change of region
-- reads the peer's caches feed again from the start.
ALTER TABLE fed_peers ADD COLUMN caches_region TEXT NOT NULL DEFAULT '';
