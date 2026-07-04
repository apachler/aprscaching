-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0001_baseline — the full 1.0 schema in one baseline file. A fresh DB on any runtime
-- (D1 / better-sqlite3 / bun:sqlite) applies this single file; sections below group the schema:
-- core · identity/trust · features · depth · hardening · ttl index · rate limits · find idempotency.


-- ============================================================================================
-- Caching & APRS core
-- ============================================================================================
-- Caches, logs, positions, stations, sensors, messages; accounts &
-- auth (passkeys + APRS-message verification); the federation mirror; corroboration;
-- per-operator signing keys; heritage imports; multi-stage caches; the store-and-forward BBS base.

-- ─── init ───
-- aprscaching.com — D1 schema (SQLite)
-- APRScaching is the core; positions power presence verification.

------------------------------------------------------------------- IDENTITY
CREATE TABLE accounts (
  callsign      TEXT PRIMARY KEY,
  verified      INTEGER NOT NULL DEFAULT 0,
  verify_method TEXT,                       -- aprs_msg | aprs_tx | external
  verified_at   INTEGER,
  display_name  TEXT,
  home_grid     TEXT,
  created_at    INTEGER NOT NULL
);

--------------------------------------------------------------------- CACHES
CREATE TABLE caches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,         -- AC-1234 (native) or imported code
  owner_call  TEXT NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL,                -- single | two_stage | multi | aprs_living | audio | traditional | sota | pota
  status      TEXT NOT NULL DEFAULT 'active', -- active | disabled | archived
  difficulty  REAL DEFAULT 1.5,             -- 1.0..5.0
  terrain     REAL DEFAULT 1.5,             -- 1.0..5.0
  lat         REAL,                         -- final coords (or stage-1 for staged)
  lon         REAL,
  station_call TEXT,                        -- aprs_living: the beaconing station that IS the cache
  source      TEXT NOT NULL DEFAULT 'native', -- native | opencaching | sota | pota
  external_id TEXT,                         -- OC code / SOTA ref / POTA ref
  hint        TEXT,
  description TEXT,
  -- per-cache verification override (NULL = use site policy)
  min_trust   TEXT,                         -- A | B | NULL
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- spatial lookup for "caches in a bbox" / geofence loading.
-- NB: Cloudflare D1 does not allow CREATE VIRTUAL TABLE (rtree/fts), so we use a plain
-- lat/lon index. A range scan on lat + lon filter is plenty for expected cache volumes.
CREATE INDEX idx_caches_geo ON caches(lat, lon);
CREATE INDEX idx_caches_status ON caches(status);

CREATE TABLE cache_stages (
  cache_id  INTEGER NOT NULL,
  stage_no  INTEGER NOT NULL,
  lat       REAL, lon REAL,
  clue      TEXT,
  unlock    TEXT,                           -- coords | audio | puzzle
  PRIMARY KEY (cache_id, stage_no)
);

----------------------------------------------------------------------- LOGS
CREATE TABLE cache_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id      INTEGER NOT NULL,
  logger_call   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  log_type      TEXT NOT NULL,              -- found | dnf | note | maintenance | enabled | disabled
  verified      INTEGER NOT NULL DEFAULT 0,
  tier          TEXT,                       -- A | B | C
  verify_method TEXT,                       -- aprs_rf | app_geo | aprs_is | manual | none
  matched_position_id INTEGER,
  distance_m    REAL,
  comment       TEXT
);
CREATE INDEX idx_logs_cache ON cache_logs(cache_id, ts DESC);
CREATE INDEX idx_logs_logger ON cache_logs(logger_call, ts DESC);

----------------------------------------------- POSITION HISTORY (verification)
-- Logger positions kept longer than the firehose TTL so a find can be verified.
CREATE TABLE positions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  heard_via  TEXT NOT NULL,                 -- rf | aprs_is   (from q-construct)
  igate_call TEXT,                          -- the gating IGate (for independence checks)
  path       TEXT,
  source     TEXT                           -- app_geo positions land here too (heard_via='app')
);
CREATE INDEX idx_pos_call_ts ON positions(callsign, ts DESC);

--------------------------------------------------------- COMMUNITY / GAMIFY
CREATE TABLE achievements (callsign TEXT, badge TEXT, earned_at INTEGER, PRIMARY KEY (callsign, badge));
CREATE TABLE favorites    (callsign TEXT, cache_id INTEGER, PRIMARY KEY (callsign, cache_id));
CREATE TABLE watches      (callsign TEXT, cache_id INTEGER, PRIMARY KEY (callsign, cache_id));

------------------------------------------------ WORKBENCH (platform, minimal)
CREATE TABLE stations (
  callsign TEXT PRIMARY KEY, ssid INTEGER, symbol TEXT,
  lat REAL, lon REAL, last_seen INTEGER,
  course INTEGER, speed_kn INTEGER, altitude_m INTEGER,
  status_color TEXT, comment TEXT, source_call TEXT
);
CREATE INDEX idx_stations_geo ON stations(lat, lon);

CREATE TABLE sensor_readings (
  station TEXT, ts INTEGER, temp_c REAL, humidity REAL, pressure_hpa REAL,
  wind_dir INTEGER, wind_kn REAL, rain_mm REAL, PRIMARY KEY (station, ts)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER,
  from_call TEXT, to_call TEXT, body TEXT, ack TEXT, direction TEXT
);

CREATE TABLE port_stats (port TEXT, ts INTEGER, rx INTEGER, tx INTEGER, PRIMARY KEY (port, ts));

-- ─── auth announce ───
-- Auth layer (passkey identity + async callsign-control badge) and the APRS-IS announce outbox.

-------------------------------------------------- IDENTITY: passkeys (WebAuthn)
CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,        -- credential ID (base64url)
  callsign    TEXT NOT NULL,
  public_key  BLOB NOT NULL,
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_cred_callsign ON credentials(callsign);

-- short-lived challenges for passkey ceremonies AND magic-links / APRS codes
CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,
  callsign    TEXT,
  kind        TEXT NOT NULL,           -- webauthn_reg | webauthn_login | magic | aprs_code
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

------------------------------------- CALLSIGN-CONTROL VERIFICATION (the badge)
-- Async; NEVER blocks logging. Gates the APRS-IS announce feature + competitive credit.
CREATE TABLE callsign_verifications (
  callsign    TEXT PRIMARY KEY,
  method      TEXT,                    -- aprs_msg | aprs_tx | lotw | qrz | external
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | verified | failed
  challenge   TEXT,                    -- one-time code we sent / token to TX
  verified_at INTEGER
);

-------------------------------------------------- ACCOUNT FLAGS
ALTER TABLE accounts ADD COLUMN announce_is INTEGER NOT NULL DEFAULT 0; -- opt-in: publish finds to APRS-IS
ALTER TABLE accounts ADD COLUMN announce_tocall TEXT DEFAULT 'APZACG';  -- experimental tocall until registered

------------------------------------------------------------ APRS-IS OUTBOX
-- Worker enqueues; the ingest box (only holder of the APRS-IS uplink) publishes via
-- third-party format. Excluded from verification by construction (status, not position).
CREATE TABLE aprs_outbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  src_call  TEXT NOT NULL,             -- the user's VERIFIED callsign (inner source)
  tocall    TEXT NOT NULL DEFAULT 'APZACG',
  kind      TEXT NOT NULL,             -- status | message
  payload   TEXT NOT NULL,             -- e.g. ">Found AC-1234 (Reutersley) via aprscaching.com"
  status    TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  sent_at   INTEGER
);
CREATE INDEX idx_outbox_status ON aprs_outbox(status, ts);

-- ─── federation mirror ───
-- Federation mirror — peers we pull from, and the records we mirror locally.
-- Mirrored rows are display-only: never treated as our own, never re-published in our feeds.

CREATE TABLE fed_peers (
  url           TEXT PRIMARY KEY,        -- base URL of the peer instance
  instance      TEXT,                    -- discovered instance id (from /.well-known)
  public_key    TEXT,                    -- discovered Ed25519 public key (raw, base64url)
  caches_cursor INTEGER NOT NULL DEFAULT 0,
  finds_cursor  INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_sync     INTEGER,
  last_error    TEXT
);

CREATE TABLE remote_caches (
  global_id    TEXT PRIMARY KEY,         -- e.g. oe.aprscaching.org:cache:42
  origin       TEXT NOT NULL,            -- originating instance id
  code         TEXT, owner_call TEXT, title TEXT, type TEXT, status TEXT,
  difficulty   REAL, terrain REAL, lat REAL, lon REAL,
  station_call TEXT, source TEXT, external_id TEXT, hint TEXT, description TEXT, min_trust TEXT,
  created_at   INTEGER, updated_at INTEGER,
  mirrored_at  INTEGER NOT NULL
);
CREATE INDEX idx_remote_caches_geo ON remote_caches(lat, lon);

CREATE TABLE remote_finds (
  global_id       TEXT PRIMARY KEY,      -- e.g. oe...:find:99
  origin          TEXT NOT NULL,
  cache_global_id TEXT, cache_code TEXT,
  logger_call     TEXT, ts INTEGER, log_type TEXT,
  verified        INTEGER, tier TEXT, verify_method TEXT, distance_m REAL, comment TEXT,
  mirrored_at     INTEGER NOT NULL
);
CREATE INDEX idx_remote_finds_cache ON remote_finds(cache_global_id);

-- ─── corroboration ───
-- Cross-instance verification. Record which peer corroborated a Tier-A find via RF.
ALTER TABLE cache_logs ADD COLUMN corroborated_by TEXT;

-- ─── callsign keys ───
-- Per-callsign signing. Device keys bound to callsigns; finds carry the logger's signature.

CREATE TABLE callsign_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign   TEXT NOT NULL,
  public_key TEXT NOT NULL,               -- Ed25519 raw, base64url
  label      TEXT,
  verified   INTEGER NOT NULL DEFAULT 0,  -- callsign badge-verified at registration time
  created_at INTEGER NOT NULL,
  UNIQUE (callsign, public_key)
);
CREATE INDEX idx_callsign_keys_call ON callsign_keys(callsign);

-- a find may be signed by the logger's device key (provenance, portable across instances)
ALTER TABLE cache_logs ADD COLUMN signer_key TEXT;   -- the device public key (base64url)
ALTER TABLE cache_logs ADD COLUMN author_sig TEXT;   -- signature over authorshipMessage(...)
ALTER TABLE cache_logs ADD COLUMN signed_at  INTEGER;-- client authorship time the signature covers

-- mirrored key bindings from peers (so consumers can check author signatures offline)
CREATE TABLE remote_keys (
  global_id   TEXT PRIMARY KEY,           -- origin:key:rowid
  origin      TEXT NOT NULL,
  callsign    TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  verified    INTEGER, created_at INTEGER, mirrored_at INTEGER NOT NULL
);
CREATE INDEX idx_remote_keys_call ON remote_keys(callsign);

-- per-feed cursor for the keys feed
ALTER TABLE fed_peers ADD COLUMN keys_cursor INTEGER NOT NULL DEFAULT 0;

-- ─── imports ───
-- Import / heritage. Imported caches carry a source attribution + deep link, and
-- re-importing updates in place (dedup on source + external_id).

ALTER TABLE caches ADD COLUMN source_url  TEXT;     -- deep link to the source's page for this item
ALTER TABLE caches ADD COLUMN source_name TEXT;     -- human attribution label, e.g. "SOTA", "Opencaching.de"
ALTER TABLE caches ADD COLUMN imported_at INTEGER;  -- last time this row was (re)imported

-- one row per (source, external_id) => re-imports update instead of duplicating
CREATE UNIQUE INDEX idx_caches_external ON caches(source, external_id) WHERE external_id IS NOT NULL;

-- ─── stages ───
-- Audio-cache staging: the cache_stages table (cache_id, stage_no, lat, lon, clue, unlock) carries
-- an audio-clue media key + a per-stage geofence radius, plus the per-finder unlock ledger. Stage 0
-- is the public start; later stages reveal once the finder unlocks the prior stage (a geofence at
-- it, or after its audio clue).
ALTER TABLE cache_stages ADD COLUMN media_key TEXT;
ALTER TABLE cache_stages ADD COLUMN radius_m INTEGER NOT NULL DEFAULT 60;

CREATE TABLE stage_unlocks (
  callsign    TEXT NOT NULL,
  cache_id    INTEGER NOT NULL,
  stage_no    INTEGER NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (callsign, cache_id, stage_no)
);

-- ─── account lifecycle ───
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

-- ─── bbs ───
-- BBS store-and-forward message base (connectionless / APRS-message delivery).
-- Personal mail is held until the addressee is heard, then forwarded as an APRS message with
-- ack tracking + retry. Bulletins are retrievable and deduped by BID across forwarding. The
-- format (P/B type, BID) is MBL/FBB-compatible so a connected-mode gateway can bridge.
CREATE TABLE bbs_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bid        TEXT UNIQUE,                       -- e.g. "42_oe.aprscaching.org" — dedup across peers
  type       TEXT NOT NULL,                     -- 'P' personal | 'B' bulletin
  from_call  TEXT NOT NULL,
  to_call    TEXT NOT NULL,                     -- callsign (P) or category e.g. ALL / SYSOP (B)
  subject    TEXT,
  body       TEXT NOT NULL,
  posted_at  INTEGER NOT NULL,
  expires_at INTEGER,
  origin     TEXT NOT NULL DEFAULT 'local',     -- 'local' or the instance id a bulletin forwarded from
  read_at    INTEGER                            -- personal: when the recipient read it (web)
);
CREATE INDEX idx_bbs_to ON bbs_messages(to_call, type, posted_at DESC);

-- Per-recipient delivery state for the store-and-forward (APRS) path.
CREATE TABLE bbs_delivery (
  msg_id       INTEGER NOT NULL,
  to_call      TEXT NOT NULL,
  line_no      INTEGER,                          -- the APRS message number {NN used on the wire
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  acked_at     INTEGER,
  status       TEXT NOT NULL DEFAULT 'held',     -- held | sent | acked | expired
  PRIMARY KEY (msg_id, to_call)
);
CREATE INDEX idx_bbs_delivery_call ON bbs_delivery(to_call, status);

-- ============================================================================================
-- Durable identity & federation trust
-- ============================================================================================
-- A surrogate account_id (callsign becomes mutable),
-- multiple verified base callsigns per person, supporter recognition (recognition-only, never a
-- feature gate), peer trust tiers + quarantine, GDPR tombstones, owner-field scope, account moves,
-- federation observability, and free per-IP-raising API keys.

-- ─── identity auth ───
-- Identity & auth: durable accounts (surrogate id) + email magic-link recovery.
-- Additive only — none of this gates logging. The
-- surrogate account_id makes the callsign a mutable, uniquely-held attribute (rename + re-verify).
-- WebAuthn passkeys reuse the `credentials` + `auth_challenges` tables.

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
-- Multiple verified base calls per account (the ham-correct identity model).
-- An account (person) is not one callsign: it holds one or more *base* callsigns, each verified
-- independently (the APRS message-challenge proves control of the license = the base call). The
-- active operating callsign (accounts.callsign) is just whichever held call the session is bound to.
-- Switching between held calls must NOT re-verify; only adding a new base call does.
--
-- Additive only. accounts.callsign stays the active-call anchor; account_id stays the durable id.
-- credentials/passkeys stay bound to the account's primary call (login is by the primary call),
-- so switching the active call does not move credentials.

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
-- The supporter badge + hide-nag use accounts.tier/hide_nag directly; this is for future recognition keys.
CREATE TABLE IF NOT EXISTS entitlements (
  account_id TEXT NOT NULL,
  key        TEXT NOT NULL,             -- supporter_badge | … (recognition only)
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);

-- ─── peer trust ───
-- Peer trust tiers + quarantine.
--
-- Federation is peer-approved by default, open-pull opt-in. Each peer carries a trust level and
-- records inherit their origin peer's trust at read time:
--   • trusted  — operator-curated (FED_PEERS manual peers); counts toward corroboration quorum + map.
--   • unvetted — auto-discovered (FED_DISCOVER); mirrored but FLAGGED — excluded from verification
--                (the corroboration quorum) and from the default map until promoted.
--   • blocked  — never fetched (sync or corroborate).
-- Reputation counters feed operator promote/demote.
ALTER TABLE fed_peers ADD COLUMN trust         TEXT    NOT NULL DEFAULT 'unvetted'; -- trusted | unvetted | blocked
ALTER TABLE fed_peers ADD COLUMN added_via     TEXT;                                -- manual | discovered
ALTER TABLE fed_peers ADD COLUMN approved_at   INTEGER;                             -- unix-seconds an operator trusted it
ALTER TABLE fed_peers ADD COLUMN rep_confirmed INTEGER NOT NULL DEFAULT 0;          -- corroborations later confirmed
ALTER TABLE fed_peers ADD COLUMN rep_failed    INTEGER NOT NULL DEFAULT 0;          -- corroborations contradicted

-- ─── tombstones ───
-- Signed tombstones for GDPR delete propagation.
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
-- Owner-controlled federation scope + spoiler protection.
--
-- Owners choose how far a cache travels on the network:
--   public     — federates with description (the default); the hint is NEVER federated (spoiler).
--   unlisted   — federates location/title only; description is withheld (visit the home instance).
--   local-only — never leaves this instance (excluded from /federation/caches entirely).
-- Enforced at the feed (federation.ts:cacheData drops hint always, description when unlisted;
-- CACHE_FEED filters local-only), so redaction happens before anything is signed and sent.
ALTER TABLE caches ADD COLUMN fed_scope TEXT NOT NULL DEFAULT 'public'; -- public | unlisted | local-only

-- ─── account moves ───
-- Account-move as a signed federation record.
--
-- When an account moves instances (proven by the device-key migration assertion at the target), the
-- TARGET publishes a signed move announcement so the whole network — not just source+target — learns
-- the callsign changed homes. Device-key signatures already make finds portable; this just adds
-- the "who hosts whom now" dimension. Rides the generalized feed envelope as type `account-move`.

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
-- Federation observability.
--
-- Per-peer sync metrics so an operator can see the health of the network: successful/failed sync
-- counts, the last SUCCESSFUL sync time (vs last_sync = last attempt → lag = now - last_ok), the
-- cumulative records mirrored, and the last sync's per-feed breakdown. Extends fed_peers.last_sync/
-- last_error. Feeds the reputation loop with measured inputs.
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

-- ============================================================================================
-- User features & the workbench data plane
-- ============================================================================================
-- Remote box command channel, watchlist alerts,
-- saved map views, web-push subscriptions, opt-in ham profile, weather ingest + WX TX, the user's
-- own station registry, and the cross-instance corroborator credit.

-- ─── box commands ───
-- Remote station control: a per-box command queue the operator's ingest box pulls
-- over its existing outbound connection (no inbound ports). TX-capable commands are gated on
-- callsign control-verification; RX-only boxes only ever receive read commands. Distinct from
-- federation peer identity.
CREATE TABLE IF NOT EXISTS box_commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id     TEXT NOT NULL,
  callsign   TEXT,                              -- licensed call the command operates as (TX → must be verified)
  kind       TEXT NOT NULL,                     -- beacon | message | wx_beacon | igate | digi | tx | status
  payload    TEXT,                              -- JSON command args
  status     TEXT NOT NULL DEFAULT 'queued',    -- queued | sent | done | failed
  result     TEXT,                              -- box-reported result/error
  sig        TEXT,                              -- optional Ed25519 signature for the licensed call (box-verified)
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  acked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_box_commands_poll ON box_commands (box_id, status, created_at);

-- ─── watchlist ───
-- Watchlist alerts. Watch callsigns per ACCOUNT (survives
-- callsign changes); raise an in-app alert when a watched call is heard on the network or heard
-- near a cache. Push/email delivery is the layer on top; this is the in-app fallback + store.
CREATE TABLE IF NOT EXISTS watch_calls (
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,                 -- base call (no SSID)
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, callsign)
);
CREATE INDEX IF NOT EXISTS idx_watch_calls_call ON watch_calls (callsign);

CREATE TABLE IF NOT EXISTS watch_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- heard | near_cache
  detail     TEXT,
  cache_id   INTEGER,
  lat        REAL,
  lon        REAL,
  ts         INTEGER NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_acct ON watch_alerts (account_id, ts);

-- ─── saved views ───
-- Save / share map views: a permalink short-link that restores a map state
-- (centre/zoom/layers/filters/selection). Public by default — the point is to share a link.
CREATE TABLE IF NOT EXISTS saved_views (
  slug       TEXT PRIMARY KEY,
  owner_call TEXT,
  name       TEXT,
  state      TEXT NOT NULL,                 -- JSON: { center, zoom, layers, filters, selected }
  public     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_views_owner ON saved_views (owner_call);

-- ─── notifications ───
-- Push + email-digest delivery. Web-push subscriptions (the enhancement) and
-- the email digest of unseen watch alerts (the MANDATORY fallback). In-app alerts already exist.
CREATE TABLE IF NOT EXISTS push_subs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT,
  auth       TEXT,
  topics     TEXT,                              -- comma list: nearby | new_cache | watch
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, endpoint)
);
-- track which alerts have already gone out in a digest (so we never re-send)
ALTER TABLE watch_alerts ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
-- per-account email-digest opt-out (default on — it's the iOS/no-push fallback)
ALTER TABLE accounts ADD COLUMN notify_digest INTEGER NOT NULL DEFAULT 1;

-- ─── profile ───
-- Thin, opt-in ham profile. display_name + home_grid live on accounts; these columns add the rest.
-- All fields are opt-in and self-curated; they live inside the existing GDPR export/erase.
ALTER TABLE accounts ADD COLUMN avatar_url     TEXT;     -- opt-in image URL
ALTER TABLE accounts ADD COLUMN bio            TEXT;     -- short plain text, length-capped + tag-stripped server-side
ALTER TABLE accounts ADD COLUMN links          TEXT;     -- JSON [{label,url}], http(s) only, capped count
ALTER TABLE accounts ADD COLUMN public_contact TEXT;     -- opt-in public email; NULL = not shown (account email stays private)
ALTER TABLE accounts ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 1; -- master show/hide

-- ─── weather ingest ───
-- Weather user-origination: a PWS pushes directly to the platform, stored in
-- sensor_readings under the user's -13 weather SSID. Extend the reading to the fuller APRS field set
-- (rain_mm stays = last-hour for back-compat) and add per-user push keys.
ALTER TABLE sensor_readings ADD COLUMN gust_kn        REAL;
ALTER TABLE sensor_readings ADD COLUMN rain_24h_mm    REAL;
ALTER TABLE sensor_readings ADD COLUMN rain_mid_mm    REAL;   -- since local midnight
ALTER TABLE sensor_readings ADD COLUMN luminosity_wm2 REAL;
ALTER TABLE sensor_readings ADD COLUMN snow_mm        REAL;
ALTER TABLE sensor_readings ADD COLUMN source         TEXT;   -- rf | aprs_is | ecowitt | wu | serial | cwop

CREATE TABLE IF NOT EXISTS wx_keys (
  key        TEXT PRIMARY KEY,
  callsign   TEXT NOT NULL,             -- base call; readings land under <call>-13
  account_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wx_keys_call ON wx_keys (callsign);

-- ─── account stations ───
-- Operated-stations registry. An account owns many stations — a home PWS, a
-- mountain-top digipeater / igate / node — each with its own callsign+SSID, an EXPLICIT location
-- (not just the operator's home grid), a description and roles. Weather is one capability among
-- several; a weather-capable station carries its own PWS push key (wx_keys.station_id).
CREATE TABLE IF NOT EXISTS account_stations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  callsign    TEXT NOT NULL,              -- full callsign incl. SSID, e.g. OE8APR-1
  lat         REAL,
  lon         REAL,
  symbol      TEXT,                       -- APRS symbol char (role default if unset)
  description TEXT,
  roles       TEXT NOT NULL DEFAULT '',   -- csv subset of: weather,digipeater,igate,node,relay
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_stations_call ON account_stations (callsign);
CREATE INDEX IF NOT EXISTS idx_account_stations_acct ON account_stations (account_id);

-- A weather push key now feeds a specific station row (null = legacy <call>-13 home PWS).
ALTER TABLE wx_keys ADD COLUMN station_id INTEGER;

-- ─── corroborator igate ───
-- Cross-instance corroborator credit. Persist the IGate that corroborated each
-- Tier-A find directly on the log, so the corroborator leaderboard credits the operator who actually
-- did the RF corroboration — whether it happened on THIS instance (the matched position's gating
-- IGate) or on a federated peer that revealed its IGate (FED_REVEAL_IGATE, both-opt-in). Peer-
-- corroborated finds have no matched_position_id, so the IGate is recorded here directly.
ALTER TABLE cache_logs ADD COLUMN corroborator_igate TEXT;

CREATE INDEX IF NOT EXISTS idx_logs_corroborator ON cache_logs (corroborator_igate);

-- ─── weather tx ───
-- Weather TX. Per-PWS opt-in flags (off by default,
-- gated on a control-verified callsign) and a beacon throttle, plus an outbox target so the ingest
-- box routes a queued WX report to standard APRS-IS or to CWOP/NOAA.
ALTER TABLE wx_keys ADD COLUMN tx_is       INTEGER NOT NULL DEFAULT 0;  -- APRS-IS weather beacon
ALTER TABLE wx_keys ADD COLUMN tx_cwop     INTEGER NOT NULL DEFAULT 0;  -- CWOP relay (NOAA)
ALTER TABLE wx_keys ADD COLUMN last_beacon INTEGER;                     -- throttle (epoch s)

ALTER TABLE aprs_outbox ADD COLUMN target TEXT NOT NULL DEFAULT 'is';   -- is | cwop  (drain routing)

-- ============================================================================================
-- Depth
-- ============================================================================================
-- Bulletin federation, position telemetry, the raw-packet workbench ring, cache
-- metadata / ratings / NFC unlock / media, living-cache rendezvous, threaded BBS + hierarchical
-- forwarding + partners + forward log, the NET/ROM node, account preferences, and the federation relay queue.

-- ─── bbs federation ───
-- Bulletin federation: peers exchange bulletins over the signed feed mechanism, deduped by
-- BID. A per-peer cursor makes the bulletin pull incremental, like the cache/find/key feeds.
ALTER TABLE fed_peers ADD COLUMN bulletins_cursor INTEGER NOT NULL DEFAULT 0;

-- ─── position telemetry ───
-- Telemetry history: the station table keeps only the *latest* speed/altitude/
-- course, so it holds no motion history to graph. Carry the per-fix telemetry onto positions too,
-- so the workbench can chart speed/altitude/course over time alongside the weather series. Back-data
-- stays NULL; new fixes fill it. Cheap, additive, all three runtimes (D1 / better-sqlite3 / bun).
ALTER TABLE positions ADD COLUMN speed_kn    REAL;
ALTER TABLE positions ADD COLUMN altitude_m  REAL;
ALTER TABLE positions ADD COLUMN course      INTEGER;

-- ─── packets recent ───
-- Raw per-station packet history for the workbench. A short, hard-TTL ring of the
-- raw TNC2 frames we've heard, so an operator can inspect a station's recent traffic verbatim. This is
-- a workbench-only diagnostic, NOT a long-term log — pruned aggressively by the scheduled job (cost
-- rule: persist selectively + TTL). Keyed for "latest N for this callsign" reads.
CREATE TABLE packets_recent (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign  TEXT NOT NULL,            -- the source station (src)
  ts        INTEGER NOT NULL,
  dst       TEXT,
  path      TEXT,                     -- comma-joined digi path
  payload   TEXT,                     -- the information field, verbatim
  heard_via TEXT,                     -- rf | aprs_is
  port      TEXT
);
CREATE INDEX idx_packets_recent_cs ON packets_recent (callsign, ts);
CREATE INDEX idx_packets_recent_ts ON packets_recent (ts);

-- ─── cache metadata ───
-- Cache metadata from the original APRSCaching concept: a car-accessible "Drive-In"
-- flag, a country, and free-form tags. All additive/optional; tags are stored comma-joined (the
-- gateway dedupes + lowercases). Country is owner-set (a coordinate-derived default can follow once a
-- geocoder is wired). All three runtimes (D1 / better-sqlite3 / bun).
ALTER TABLE caches ADD COLUMN drive_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE caches ADD COLUMN country  TEXT;
ALTER TABLE caches ADD COLUMN tags     TEXT;   -- comma-joined free tags

-- ─── cache ratings ───
-- Owner-gated cache rating: a 1–5 star rating, distinct from favourites. The owner
-- chooses WHO may rate via caches.rating_policy: 'finders' (default — only those who logged a verified
-- find), 'all' (any signed-in callsign), or 'off' (disabled). One rating per callsign per cache (an
-- upsert). All three runtimes.
CREATE TABLE cache_ratings (
  cache_id INTEGER NOT NULL,
  callsign TEXT NOT NULL,
  stars    INTEGER NOT NULL,            -- 1..5
  ts       INTEGER NOT NULL,
  PRIMARY KEY (cache_id, callsign)
);
CREATE INDEX idx_cache_ratings_cache ON cache_ratings (cache_id);
ALTER TABLE caches ADD COLUMN rating_policy TEXT NOT NULL DEFAULT 'finders';

-- ─── stage nfc ───
-- NFC stage unlock: the original APRSCaching hid stage-2 coordinates behind an NFC tag.
-- A stage with unlock='nfc' carries a secret (the tag's text/serial); the finder reveals the stage by
-- presenting it — tapped in-browser via WebNFC (Android Chromium) or typed as a manual-code fallback.
-- The secret is never exposed by the read endpoints (those select explicit columns). All runtimes.
ALTER TABLE cache_stages ADD COLUMN unlock_secret TEXT;

-- ─── cache media ───
-- Cache media attachments: the original APRSCaching let owners attach photos, audio and
-- data files (hints, circuit diagrams, the audio sample) to a cache. Stored in the MEDIA object store
-- (R2 on CF, filesystem on Node/Bun) like the stage clues; this table is the per-cache index. Owner-
-- managed, size/type-limited at the handler. All three runtimes.
CREATE TABLE cache_media (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id     INTEGER NOT NULL,
  media_key    TEXT NOT NULL,             -- object-store key
  kind         TEXT NOT NULL,             -- image | audio | file
  content_type TEXT NOT NULL,
  title        TEXT,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_cache_media_cache ON cache_media (cache_id);

-- ─── rendezvous ───
-- Living-cache rendezvous: in the original APRSCaching, two *living* caches (beaconing
-- stations that ARE caches) who meet both log each other — a deliberately social "make new
-- acquaintances" mechanic. Opt-in per living cache (caches.rendezvous). A meeting is recorded when two
-- opted-in living caches are co-located and both beaconed within a short window. This is a SOCIAL
-- record, deliberately kept OUT of the A/B/C verified-find tiers (two colluding stations must not be
-- able to farm verified finds by parking together). All three runtimes.
ALTER TABLE caches ADD COLUMN rendezvous INTEGER NOT NULL DEFAULT 0;

CREATE TABLE rendezvous_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_a  INTEGER NOT NULL,   -- the living cache that just beaconed
  cache_b  INTEGER NOT NULL,   -- the co-located living cache it met
  call_a   TEXT NOT NULL,
  call_b   TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  lat      REAL,
  lon      REAL
);
CREATE INDEX idx_rendezvous_a ON rendezvous_log (cache_a, ts);
CREATE INDEX idx_rendezvous_b ON rendezvous_log (cache_b, ts);

-- ─── bbs threads ───
-- FBB-style BBS uplift: a thread tree on the message base so replies (SR) chain into
-- conversations, and 'T' (NTS traffic) joins the existing 'P'/'B' typing (type stays free TEXT). reply_to
-- points at the parent message; thread_id is the conversation root (a root message's thread_id = its own
-- id). MID/BID is the existing bbs_messages.bid (unique, deduped across peers). All three runtimes.
ALTER TABLE bbs_messages ADD COLUMN reply_to  INTEGER;
ALTER TABLE bbs_messages ADD COLUMN thread_id INTEGER;
CREATE INDEX idx_bbs_thread ON bbs_messages (thread_id, posted_at);

-- ─── bbs forwarding ───
-- BBS forwarding + hierarchical routing. bbs_forward_rules is the forward table the
-- ForwardRouter consumes: each row maps a hierarchical route token (or '*' catch-all) to a partner +
-- transport. white_pages steers personal mail by mapping a callsign to its home BBS (FBB WP). The
-- existing bulletin federation is folded in as the default 'ip-fed' catch-all partner. All runtimes.
CREATE TABLE bbs_forward_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  partner    TEXT NOT NULL,
  route      TEXT NOT NULL,                       -- hierarchical token (OE, EU, DB0XYZ…) or '*' catch-all
  transport  TEXT NOT NULL DEFAULT 'ip-fed',      -- ip-fed | rf-fbb | axip
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_fwd_enabled ON bbs_forward_rules (enabled);

CREATE TABLE white_pages (
  callsign   TEXT PRIMARY KEY,
  home_bbs   TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- the live bulletin federation IS the default catch-all forwarding partner
INSERT INTO bbs_forward_rules (partner, route, transport, enabled, created_at) VALUES ('ip-fed', '*', 'ip-fed', 1, 0);

-- ─── netrom node ───
-- NET/ROM node: the NODES routing table the node advertises + consumes, and a per-port
-- MHeard list (recently-heard stations, the classic node `MH` command). netrom_nodes is keyed by
-- destination (best route per node); node_mheard counts heard calls per radio port. The node CLI +
-- routing brain are pure (@aprsweb/packet); these tables back the read endpoints + sysop admin. All
-- three runtimes.
CREATE TABLE netrom_nodes (
  dest     TEXT PRIMARY KEY,
  alias    TEXT NOT NULL,
  neighbor TEXT NOT NULL,
  quality  INTEGER NOT NULL DEFAULT 100,
  port     TEXT,
  heard_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE node_mheard (
  callsign   TEXT NOT NULL,
  port       TEXT NOT NULL,
  last_heard INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (callsign, port)
);
CREATE INDEX idx_mheard_heard ON node_mheard (last_heard);

-- ─── account prefs ───
-- Account UI-preferences sync. A person's device-independent UI settings (theme, units/locale,
-- pinned workbench apps, basemap choice) follow the ACCOUNT, not the browser — so signing in on a
-- second device restores them. One small JSON blob per account (validated + size-capped server-side);
-- guests keep the same settings in localStorage only. Keyed by account_id (person): prefs belong to
-- the person, not a bare callsign. All three runtimes. Inside the GDPR export/erase.
CREATE TABLE account_prefs (
  account_id TEXT PRIMARY KEY,
  prefs      TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- ─── bbs partners ───
-- FBB forwarding partners. Per-partner config the ingest forwarding scheduler consumes:
-- who to connect to, how to reach them (connect script through nodes), when (interval + UTC time-bands),
-- and what to exchange (msgtypes, block/size caps, reverse-forward). This extends bbs_forward_rules
-- (route → partner) with the partner's *transport-level* settings; a rule names a partner, a partner row
-- says how to actually forward to it. Sysop-configured; RF delivery is validate-at-deploy. All runtimes.
CREATE TABLE bbs_partners (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  call            TEXT NOT NULL UNIQUE,               -- partner BBS callsign (SSID-bearing, uppercased)
  ha              TEXT,                               -- partner's hierarchical address (e.g. OE8XBM.OE.EU)
  connect_script  TEXT NOT NULL DEFAULT '',           -- how to reach it: "C NODE1" / "C 3 DB0XYZ" lines (\n-sep)
  proto           TEXT NOT NULL DEFAULT 'rf-fbb',      -- rf-fbb | axudp | ip-fed
  interval_min    INTEGER NOT NULL DEFAULT 30,         -- forwarding poll interval, minutes (0 = manual only)
  timebands       TEXT NOT NULL DEFAULT '',            -- UTC hour windows "0-6,22-23" ('' = any time)
  request_reverse INTEGER NOT NULL DEFAULT 1,          -- ask the partner to reverse-forward to us
  msgtypes        TEXT NOT NULL DEFAULT 'PBT',         -- which types we send: subset of P(ersonal) B(ulletin) T(raffic)
  max_block       INTEGER NOT NULL DEFAULT 5,          -- proposals per FBB block (spec cap = 5)
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_partners_enabled ON bbs_partners (enabled);

-- ─── bbs forward log ───
-- FBB forwarding log. Tracks which message BIDs have already been forwarded to which
-- partner so the ingest forwarding scheduler never re-offers the same message on the next session
-- (the FBB BID dedup handles the *inbound* side; this is the *outbound* per-partner memory). All runtimes.
CREATE TABLE bbs_forward_log (
  partner      TEXT NOT NULL,                    -- partner BBS callsign (bbs_partners.call)
  bid          TEXT NOT NULL,                    -- the forwarded message's BID
  forwarded_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner, bid)
);

-- ─── fed relay ───
-- Federation rendezvous relay queue. A hub holds relay queries addressed to a
-- NAT'd spoke instance; the spoke leases them over its outbound poll, answers from its own DB, and posts
-- the (signed) result back — reusing the poll-based box-command seam, so it stays tri-runtime-clean.
-- Rows are ephemeral request/response state, TTL'd by the scheduled cleanup. All runtimes.
CREATE TABLE fed_relay_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance    TEXT NOT NULL,                     -- the spoke instance this query is addressed to
  kind        TEXT NOT NULL,                     -- 'feed' | 'corroborate'
  params      TEXT,                              -- JSON query params (e.g. {feed, since})
  status      TEXT NOT NULL DEFAULT 'queued',    -- queued → leased → answered
  answer      TEXT,                              -- JSON RelayResult once the spoke replies
  created_at  INTEGER NOT NULL DEFAULT 0,
  leased_at   INTEGER,
  answered_at INTEGER
);
CREATE INDEX idx_fed_relay_lease ON fed_relay_queue (instance, status, created_at);

-- ============================================================================================
-- Reliability & security hardening
-- ============================================================================================
-- Additive columns/indexes backing the reliability/security hardening invariants.

-- Bind APRS control-verification to the initiating account and rate-limit the 6-digit code. Without
-- this binding and throttle, an unauthenticated confirm endpoint allows ~10^6 unthrottled guesses to
-- mark any callsign verified.
ALTER TABLE callsign_verifications ADD COLUMN account_id TEXT;                    -- the account that started the challenge
ALTER TABLE callsign_verifications ADD COLUMN attempts    INTEGER NOT NULL DEFAULT 0;  -- wrong-code guesses; locks after a cap
ALTER TABLE callsign_verifications ADD COLUMN created_at  INTEGER NOT NULL DEFAULT 0;  -- challenge issue time (expiry window)

-- The firehose/workbench message log is TTL-pruned and scanned per station (workbench.ts). Index it
-- so the TTL delete and the per-station reads are cheap.
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);

-- Bind a remote-control box to an owning account (claimed TOFU on first control from a session).
-- Without this binding, any signed-in user could enqueue TX commands to another operator's box —
-- remote-keying someone else's radio. The box itself still leases/acks with the ingest secret.
CREATE TABLE IF NOT EXISTS boxes (
  box_id     TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,             -- the account that controls this box
  created_at INTEGER NOT NULL
);

-- ============================================================================================
-- Firehose TTL index
-- ============================================================================================
-- The nightly firehose TTL (`DELETE FROM positions WHERE source='firehose' AND ts<?`) would
-- otherwise full-scan the largest table in the schema — on the synchronous better-sqlite3 runtime
-- that stalls the whole event loop as positions grows. This index makes the prune (and any
-- source+time query) a range scan; the delete itself is batched in app.ts.
CREATE INDEX IF NOT EXISTS idx_pos_source_ts ON positions (source, ts);

-- ============================================================================================
-- Rate-limit counters
-- ============================================================================================
-- Durable fixed-window rate-limit counters. An in-memory Map limiter resets per isolate on Workers
-- (a fan-out silently multiplies every budget) and forgets on restart, so counters live in the DB:
-- one row per (key), rolled over in place; the nightly job prunes expired windows. reset_at is unix
-- MILLISECONDS (matches the callers' Date.now() windows).
CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

-- ============================================================================================
-- Find idempotency
-- ============================================================================================
-- A verified find must be idempotent. Without uniqueness on (cache_id, logger_call) for `found`
-- logs and an already-found check in handleLog, a racing or replayed POST would run verify + insert
-- + owner-alert + announce + gossip twice and double-count the find on the leaderboard. This is the
-- guard the code relies on (INSERT OR IGNORE + a pre-check).
--
-- Dedup first (keep the earliest found per cache+logger) so the unique index can be created. Tier
-- semantics are untouched — this only prevents a *duplicate* found row for the same
-- (cache_id, logger_call).
DELETE FROM cache_logs
WHERE log_type = 'found'
  AND id NOT IN (
    SELECT MIN(id) FROM cache_logs WHERE log_type = 'found' GROUP BY cache_id, logger_call
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_logs_found_unique
  ON cache_logs (cache_id, logger_call)
  WHERE log_type = 'found';
