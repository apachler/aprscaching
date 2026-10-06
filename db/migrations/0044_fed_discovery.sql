-- How this instance heard of a peer it never added itself (feddiscover.ts): a trusted peer's list of the
-- instances it trusts (peer exchange), or an mDNS announcement on the local network. `discovered` holds the
-- sightings as JSON [{via, fp, at}]: `via` is the listing peer's instance id or `mdns`, `fp` the key
-- fingerprint that source gave, `at` when it last said so. `listed_at` is the newest sighting; a row that only
-- discovery brought and that no source lists any more expires. A sighting never sets a peer's key: a
-- fingerprint that differs from the pinned key's is shown to the sysop, and the pin stays.
ALTER TABLE fed_peers ADD COLUMN discovered TEXT;
ALTER TABLE fed_peers ADD COLUMN listed_at INTEGER;
CREATE INDEX idx_fed_peers_listed ON fed_peers (listed_at) WHERE listed_at IS NOT NULL;
