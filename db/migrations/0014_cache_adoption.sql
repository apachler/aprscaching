-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cache adoption: a sysop offers a native cache to the community (a withdrawn owner's, or an abandoned
-- one), a signed-in holder of a control-verified call requests it, and the sysop approves; or the sysop
-- assigns it straight to such a holder. Ownership stays call-based on `caches.owner_call`; the gateway
-- checks at every hand-over that the new owner's account holds the call.

-- The standing offer, one per cache. `note` is public: it says why the cache is up for adoption.
CREATE TABLE cache_adoption_offers (
  cache_id   INTEGER PRIMARY KEY,
  offered_by TEXT NOT NULL,          -- the sysop's base call
  note       TEXT NOT NULL,
  offered_at INTEGER NOT NULL
);

-- A request to adopt. `callsign` is the call that becomes the owner; `account_id` the account that held
-- it when asking. `in_place` records that the requester confirms the container is at the site, which
-- reactivates the cache on approval.
CREATE TABLE cache_adoption_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id     INTEGER NOT NULL,
  account_id   TEXT NOT NULL,
  callsign     TEXT NOT NULL,
  in_place     INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | declined | cancelled
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT
);
CREATE UNIQUE INDEX cache_adoption_requests_pending
  ON cache_adoption_requests (cache_id, account_id) WHERE status = 'pending';
CREATE INDEX cache_adoption_requests_account ON cache_adoption_requests (account_id);

-- The audit trail: every offer, withdrawal, request, decision and hand-over, with who, when, the owner
-- before and after, and the note. Erasure anonymises a person's calls here and drops the notes.
CREATE TABLE cache_adoptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,  -- offered | offer_withdrawn | owner_declined | requested | request_cancelled | declined | approved | assigned
  actor_call TEXT NOT NULL,
  from_call  TEXT,
  to_call    TEXT,
  note       TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX cache_adoptions_cache ON cache_adoptions (cache_id, id);
CREATE INDEX cache_adoptions_at ON cache_adoptions (at);
