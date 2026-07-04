-- Federation transports: a peer's identity is its instance id + published signing keys; its
-- ADDRESSES are data. `endpoints` carries the ordered, typed endpoint set as a JSON array of
-- {transport, address, priority, verifiedVia} with transport ∈ https | 44net | ax25 | netrom | bbs.
-- The https `url` primary key stays the row identity and the fallback endpoint when the set is empty.
ALTER TABLE fed_peers ADD COLUMN endpoints TEXT;

-- How this peer's callsign/name binding was established (e.g. 'ardc-lot' — an ARDC-reviewed
-- <call>.ampr.org delegation). This attests IDENTITY only; data trust stays the operator-set
-- `trust` tier — transport is never trust.
ALTER TABLE fed_peers ADD COLUMN verified_via TEXT;
