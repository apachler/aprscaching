-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0002 identity trust  —  consolidated initial schema (part 2 of 4)
-- Durable identity & federation trust — a surrogate account_id (callsign becomes mutable),
-- multiple verified base callsigns per person, supporter recognition (recognition-only, never a
-- feature gate), peer trust tiers + quarantine, GDPR tombstones, owner-field scope, account moves,
-- federation observability, and free per-IP-raising API keys.
-- Squashed baseline: greenfield deploys create the whole schema from these four files.

-- ─── identity auth ───
-- M9 identity & auth: durable accounts (surrogate id) + email magic-link recovery.
-- Additive only — nothing here gates logging yet (that lands with the web sign-in UI). The
-- surrogate account_id makes the callsign a mutable, uniquely-held attribute (rename + re-verify).
-- WebAuthn passkeys reuse the existing `credentials` + `auth_challenges` tables from 0002 (S2).

ALTER TABLE accounts ADD COLUMN account_id TEXT;   -- durable identity (callsign is mutable)
ALTER TABLE accounts ADD COLUMN email TEXT;         -- recovery / magic-link address
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON accounts(account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

-- magic-link email tokens (email register / login / recovery)
CREATE TABLE email_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  callsign   TEXT,                 -- desired callsign for a new-account register
  purpose    TEXT NOT NULL,        -- 'register' | 'login'
  created_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- audit of callsign changes (one active callsign per account; re-verify on change)
CREATE TABLE callsign_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,
  set_at     INTEGER NOT NULL,
  verified   INTEGER NOT NULL DEFAULT 0
);

-- ─── account callsigns ───
-- Multiple verified base calls per account (the ham-correct identity model §19).
-- An account (person) is not one callsign: it holds one or more *base* callsigns, each verified
-- independently (the APRS message-challenge proves control of the license = the base call). The
-- active operating callsign (accounts.callsign) is just whichever held call the session is bound to.
-- Switching between held calls must NOT re-verify; only adding a new base call does.
--
-- Additive only. accounts.callsign stays the active-call anchor; account_id stays the durable id.
-- credentials/passkeys stay bound to the account's primary call (login is by the primary call),
-- so switching the active call no longer moves credentials.

CREATE TABLE IF NOT EXISTS account_callsigns (
  account_id  TEXT NOT NULL,             -- durable account (accounts.account_id)
  callsign    TEXT NOT NULL,             -- BASE call only (no SSID); the license
  verified    INTEGER NOT NULL DEFAULT 0,
  method      TEXT,                       -- 'aprs_msg' | 'lotw' | …
  verified_at INTEGER,
  is_primary  INTEGER NOT NULL DEFAULT 0, -- the call the passkey/credentials are bound to
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, callsign)
);
-- a base call is held by at most one account (prevents two accounts claiming the same license)
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_callsigns_call ON account_callsigns(callsign);

-- ─── supporter recognition ───
-- Supporter recognition + transparency ledger. RECOGNITION ONLY — never a feature gate.
-- (Migration number pinned to 0012 per; lands after 0011_account_callsigns, fills the
--  reserved gap. The migrator applies by filename, so this is safe to add after later migrations.)

-- accounts.tier is a thank-you level (free | supporter); hide_nag suppresses the support prompt.
-- NO core handler may read tier/entitlements to RESTRICT anything — donations unlock nothing functional.
ALTER TABLE accounts ADD COLUMN tier     TEXT    NOT NULL DEFAULT 'free';
ALTER TABLE accounts ADD COLUMN hide_nag INTEGER NOT NULL DEFAULT 0;

-- Public transparency ledger: what came in and how it was spent, per bucket.
CREATE TABLE IF NOT EXISTS ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  direction    TEXT NOT NULL,            -- in | out
  bucket       TEXT NOT NULL,            -- development | hosting | operation | peer_reimbursement
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'EUR',
  note         TEXT,
  source       TEXT                      -- liberapay | kofi | patreon | opencollective | manual
);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger (ts);

-- Recognition entitlements ONLY (reserved seam) — keyed recognition flags, never functional limits.
-- The M4 badge + hide-nag use accounts.tier/hide_nag directly; this is for future recognition keys.
CREATE TABLE IF NOT EXISTS entitlements (
  account_id TEXT NOT NULL,
  key        TEXT NOT NULL,             -- supporter_badge | … (recognition only)
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);

-- ─── peer trust ───
-- 0012_peer_trust.sql — F4/T1.1: peer trust tiers + quarantine (launch-gating).
--
-- Federation becomes peer-approved by default, open-pull opt-in. Each peer carries a trust level and
-- records inherit their origin peer's trust at read time:
--   • trusted  — operator-curated (FED_PEERS manual peers); counts toward corroboration quorum + map.
--   • unvetted — auto-discovered (FED_DISCOVER); mirrored but FLAGGED — excluded from verification
--                (the corroboration quorum, T1.2) and from the default map until promoted.
--   • blocked  — never fetched (sync or corroborate).
-- Reputation counters feed operator promote/demote (auto-promotion past a threshold lands later).
ALTER TABLE fed_peers ADD COLUMN trust         TEXT    NOT NULL DEFAULT 'unvetted'; -- trusted | unvetted | blocked
ALTER TABLE fed_peers ADD COLUMN added_via     TEXT;                                -- manual | discovered
ALTER TABLE fed_peers ADD COLUMN approved_at   INTEGER;                             -- unix-seconds an operator trusted it
ALTER TABLE fed_peers ADD COLUMN rep_confirmed INTEGER NOT NULL DEFAULT 0;          -- corroborations later confirmed
ALTER TABLE fed_peers ADD COLUMN rep_failed    INTEGER NOT NULL DEFAULT 0;          -- corroborations contradicted

-- ─── tombstones ───
-- 0014_tombstones.sql — F4/T1.3 + ADR-5: signed tombstones for GDPR delete propagation.
--
-- A delete on one instance must remove the PII-bearing mirrored copies on peers. Anonymising a find
-- locally is not enough: the finds feed cursor is append-only by id, so an UPDATE never re-serves the
-- anonymised row — peers keep the pre-deletion copy (with the real callsign) forever. A signed,
-- PII-free tombstone actively tells peers "purge mirrored record <global-id>". Caches instead
-- propagate via archive + updated_at bump (they re-serve through the caches feed), so account-delete
-- emits find tombstones; the apply path handles any kind uniformly by global id.

-- Our own tombstones — served in our signed /federation/tombstones feed (origin = this instance).
CREATE TABLE tombstones (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic feed cursor (the uuid id is not ordered)
  id         TEXT NOT NULL UNIQUE,              -- uuid of the tombstone
  kind       TEXT NOT NULL,                     -- 'account' | 'find' | 'cache'
  target_id  TEXT NOT NULL,                     -- namespaced global id of the removed record (NEVER a callsign/PII)
  origin     TEXT NOT NULL,                     -- emitting instance
  ts         INTEGER NOT NULL,                  -- emit time (unix seconds)
  sig        TEXT                               -- reserved; the feed signs at serve time like the other feeds
);
CREATE INDEX idx_tombstones_ts ON tombstones(ts);

-- Applied peer tombstones — suppress re-mirroring, give idempotency, and bound retention.
CREATE TABLE remote_tombstones (
  target_id   TEXT PRIMARY KEY,  -- the global id a peer tombstoned (lookup on every mirror upsert)
  origin      TEXT NOT NULL,     -- the instance that emitted it
  kind        TEXT NOT NULL,
  ts          INTEGER NOT NULL,  -- emit time carried from the tombstone
  mirrored_at INTEGER NOT NULL
);

-- Per-peer cursor for the tombstones feed (parallels caches/finds/keys cursors).
ALTER TABLE fed_peers ADD COLUMN tombstones_cursor INTEGER NOT NULL DEFAULT 0;

-- ─── fed scope ───
-- 0015_fed_scope.sql — F6/T3.3: owner-controlled federation scope + spoiler protection.
--
-- Owners choose how far a cache travels on the network:
--   public     — federates with description (the default); the hint is NEVER federated (spoiler).
--   unlisted   — federates location/title only; description is withheld (visit the home instance).
--   local-only — never leaves this instance (excluded from /federation/caches entirely).
-- Enforced at the feed (federation.ts:cacheData drops hint always, description when unlisted;
-- CACHE_FEED filters local-only), so redaction happens before anything is signed and sent.
ALTER TABLE caches ADD COLUMN fed_scope TEXT NOT NULL DEFAULT 'public'; -- public | unlisted | local-only

-- ─── account moves ───
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

-- ─── fed observability ───
-- 0017_fed_observability.sql — F7/T4.3: federation observability.
--
-- Per-peer sync metrics so an operator can see the health of the network: successful/failed sync
-- counts, the last SUCCESSFUL sync time (vs last_sync = last attempt → lag = now - last_ok), the
-- cumulative records mirrored, and the last sync's per-feed breakdown. Extends fed_peers.last_sync/
-- last_error (already present). Feeds the T1.1 reputation loop with measured inputs.
ALTER TABLE fed_peers ADD COLUMN last_ok        INTEGER;                 -- last SUCCESSFUL sync (unix s)
ALTER TABLE fed_peers ADD COLUMN sync_ok        INTEGER NOT NULL DEFAULT 0; -- successful sync count
ALTER TABLE fed_peers ADD COLUMN sync_err       INTEGER NOT NULL DEFAULT 0; -- failed sync count
ALTER TABLE fed_peers ADD COLUMN mirrored_total INTEGER NOT NULL DEFAULT 0; -- cumulative records mirrored
ALTER TABLE fed_peers ADD COLUMN last_counts    TEXT;                    -- JSON per-feed counts of the last sync

-- ─── api keys ───
-- Public read API: free, per-IP rate-limited; free api_keys raise the limit
-- (recognition model — keys are never paywalled). Read-only; keys carry no scopes beyond the
-- public read surface today.
CREATE TABLE IF NOT EXISTS api_keys (
  key          TEXT PRIMARY KEY,
  owner_call   TEXT,
  label        TEXT,
  rate_tier    TEXT NOT NULL DEFAULT 'free',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys (owner_call);
