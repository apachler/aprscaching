-- 0016_account_moves.sql — F6/T3.2: account-move as a signed federation record (pairs with ADR-2).
--
-- When an account moves instances (proven by the device-key migration assertion at the target), the
-- TARGET publishes a signed move announcement so the whole network — not just source+target — learns
-- the callsign changed homes. Device-key signatures (F0) already make finds portable; this just adds
-- the "who hosts whom now" dimension. Rides the generalized feed envelope (T2.2) as type `account-move`.

-- Our own move announcements — served on /federation/account-moves (signed at serve time).
CREATE TABLE account_moves (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic feed cursor
  callsign      TEXT NOT NULL,
  from_instance TEXT,                              -- where the account came from (may be unknown)
  to_instance   TEXT NOT NULL,                     -- the new home (this instance, at publish time)
  ts            INTEGER NOT NULL
);
CREATE INDEX idx_account_moves_call ON account_moves(callsign);

-- Mirrored from peers: the latest known home per callsign (last-writer wins by ts).
CREATE TABLE remote_account_moves (
  callsign      TEXT PRIMARY KEY,
  from_instance TEXT,
  to_instance   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  origin        TEXT NOT NULL,   -- the instance that announced the move
  mirrored_at   INTEGER NOT NULL
);

ALTER TABLE fed_peers ADD COLUMN moves_cursor INTEGER NOT NULL DEFAULT 0;
