-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Federation identity binding: one instance id belongs to exactly one live peer row, a peer's
-- verified key set is stored with it, and the signed registry's high-water mark is persisted.

-- An instance id names one peer. Two non-blocked rows claiming the same id mean one of them is an
-- impostor (or a stale URL), and picking a winner automatically could keep the impostor, so the
-- migration stops here and names the fix: block or delete every row but the genuine peer (the
-- query is in docs/guides/federation.md, "One row per instance"), then apply the migration again.
CREATE TABLE fed_identity_precheck (
  duplicates INTEGER CONSTRAINT "several non-blocked fed_peers rows claim one instance id: block or delete all but the genuine peer (docs/guides/federation.md, One row per instance), then migrate again" CHECK (duplicates = 0)
);
INSERT INTO fed_identity_precheck
  SELECT COUNT(*) FROM (
    SELECT instance FROM fed_peers
     WHERE instance IS NOT NULL AND trust != 'blocked'
     GROUP BY instance HAVING COUNT(*) > 1
  );
DROP TABLE fed_identity_precheck;

CREATE UNIQUE INDEX fed_peers_instance_live ON fed_peers(instance) WHERE trust != 'blocked';

-- The keys this peer's frames verify under, as last verified over HTTP: the pinned key plus any
-- predecessor still inside its rotation grace, as JSON [{x, until?}]. A key with a passed `until`
-- stays listed so a later descriptor can never revive it.
ALTER TABLE fed_peers ADD COLUMN accept_keys TEXT;

-- The last good signed registry per authority key, fetched via FED_REGISTRY_DNS: `max_at` rejects a
-- replayed older document, and `doc` keeps enforcing its bindings when the registry is unreachable.
CREATE TABLE fed_registry_state (
  authority_key TEXT PRIMARY KEY,
  max_at        INTEGER NOT NULL,
  doc           TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);
