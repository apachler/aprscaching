-- The key fingerprint the sysop pinned for a FED_PEERS entry (`<url>#<fingerprint>`): SHA-256 of the raw
-- Ed25519 key, its first 16 hex digits in four groups of four. A sync refuses a peer whose keys do not match it, and a peer whose
-- key matches starts trusted; an entry without one starts unvetted until the sysop compares fingerprints.
ALTER TABLE fed_peers ADD COLUMN pinned_fingerprint TEXT;
