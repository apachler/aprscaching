-- A suspension outlives the erasure of its account. Erasure removes the account and everything tied to it,
-- and leaves this minimal record per base call it held: the call, the reason category and the end. No free
-- text and no account id. While it holds, no account registers, adds, switches to or claims the call; it is
-- deleted when the suspension ends (nightly prune) or when the sysop lifts it.
CREATE TABLE callsign_suspensions (
  callsign TEXT PRIMARY KEY,                      -- base call
  category TEXT NOT NULL,                         -- spam | offensive | unsafe | copyright | other
  until    INTEGER,                               -- NULL holds until the sysop lifts it
  at       INTEGER NOT NULL
);

-- The category a suspension is filed under: the one thing about it that outlives an erasure.
ALTER TABLE account_suspensions ADD COLUMN category TEXT NOT NULL DEFAULT 'other';

-- Every path that gives an account a call writes account_callsigns: a call under a suspension in force never
-- gets there, whichever handler is asked.
CREATE TRIGGER account_callsigns_suspended BEFORE INSERT ON account_callsigns
WHEN EXISTS (
  SELECT 1 FROM callsign_suspensions
   WHERE callsign = NEW.callsign AND (until IS NULL OR until > CAST(strftime('%s', 'now') AS INTEGER))
)
BEGIN
  SELECT RAISE(ABORT, 'callsign suspended');
END;
