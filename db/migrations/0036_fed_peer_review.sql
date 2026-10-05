-- Where a peer's endpoint set came from: 'dns' (its 44Net callsign binding, set when it is added by callsign),
-- 'descriptor' (the `addresses` its own descriptor lists, read on each sync) or 'announce' (a verified presence
-- beacon). A sync replaces only a set it learned itself, never one DNS set.
ALTER TABLE fed_peers ADD COLUMN endpoints_source TEXT;
UPDATE fed_peers SET endpoints_source = 'dns' WHERE added_via = '44net' AND endpoints IS NOT NULL;

-- The key a FED_PEERS fingerprint pin matched. The pin then holds for every key reached from it along the
-- peer's verified rotation chain, so a rotation past its grace period keeps the peer.
ALTER TABLE fed_peers ADD COLUMN pin_matched_key TEXT;

-- When corroboration raised an unvetted peer to trusted on its own. `added_via` keeps how the peer arrived; an
-- operator's trust decision clears this.
ALTER TABLE fed_peers ADD COLUMN auto_promoted_at INTEGER;
UPDATE fed_peers SET auto_promoted_at = COALESCE(approved_at, 0) WHERE added_via = 'auto-promoted';

-- A block covers the instance, not one address: no live row may name a blocked instance.
UPDATE fed_peers SET trust = 'blocked'
 WHERE trust != 'blocked'
   AND instance IN (SELECT instance FROM fed_peers WHERE trust = 'blocked' AND instance IS NOT NULL);

-- The cache version a moderation removal's tombstone covers (NULL: every version, as for an erasure). A cache
-- the sysop restores comes back at a higher version, which the tombstone no longer suppresses.
ALTER TABLE tombstones ADD COLUMN up_to INTEGER;
ALTER TABLE remote_tombstones ADD COLUMN up_to INTEGER;
