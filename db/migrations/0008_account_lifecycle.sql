-- Account data lifecycle: a small ledger of erasures and migrations. Used to honour GDPR
-- right-to-erasure (tombstone) and account portability across federation peers, and to drive
-- redirects ("this callsign moved to <instance>") + downstream mirror purges.
CREATE TABLE account_events (
  callsign TEXT NOT NULL,
  action   TEXT NOT NULL,          -- 'deleted' | 'moved'
  detail   TEXT,                   -- e.g. target instance for a move
  at       INTEGER NOT NULL,
  PRIMARY KEY (callsign, action)
);
