-- SPDX-License-Identifier: AGPL-3.0-or-later
-- An account move is only as trustworthy as the mover's proof, so the move carries it: the device-key
-- assertion the mover signed on import (accountActionMessage "migrate", bound to the target instance).
-- A mirror keeps a move only when that proof verifies under a key it knows for the callsign by its own
-- registration or from a trusted peer's verified key, never from the instance claiming the move.
ALTER TABLE account_moves ADD COLUMN proof_key TEXT;
ALTER TABLE account_moves ADD COLUMN proof_sig TEXT;
ALTER TABLE account_moves ADD COLUMN proof_at INTEGER;

-- The mirrored move's global id, so the origin's tombstone can purge it when the account is erased,
-- and its proof time: moves are ordered by when the mover signed them, so a former home re-announcing
-- an old proof under a fresh timestamp never takes the account back.
ALTER TABLE remote_account_moves ADD COLUMN global_id TEXT;
ALTER TABLE remote_account_moves ADD COLUMN proof_at INTEGER;
