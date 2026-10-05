-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The aprscaching schema. The Node (better-sqlite3), Bun (bun:sqlite) and desktop servers apply it to
-- a fresh database at boot. It holds no virtual tables (rtree, FTS), so it stays portable across SQLite
-- builds: spatial lookups use plain (lat, lon) indexes and search is LIKE-based.
--
-- Times are unix seconds unless a column says otherwise. Callsigns are stored uppercase; a "base call"
-- is the licence without an SSID.
--
-- Domains, in order:
--   1. Accounts & identity          5. Stations, positions & weather
--   2. Callsign verification        6. Radio commands, outbox & remote boxes
--   3. Caches & finds               7. BBS & packet node
--   4. Community & notifications    8. Federation
--                                   9. Operations


-- ============================================================================================
-- 1. Accounts & identity
-- ============================================================================================
-- An account is a person. `account_id` is the durable identity; `accounts.callsign` is the active
-- operating call, a mutable attribute. A person holds one or more base calls (account_callsigns), and
-- switching between held calls never re-verifies. Profiles are thin and opt-in, and every column here
-- is inside the GDPR export/erase tools.

CREATE TABLE accounts (
  callsign       TEXT PRIMARY KEY,                 -- the active operating call (may carry an SSID)
  account_id     TEXT NOT NULL,                    -- durable identity; every account row carries one
  email          TEXT,                             -- recovery / magic-link address (never shown)
  created_at     INTEGER NOT NULL,
  -- a session names the account and this generation; bumping it ends every session the account holds
  -- (sign out everywhere, active-call change)
  session_gen    INTEGER NOT NULL DEFAULT 0,
  -- opt-in profile, self-curated
  display_name   TEXT,
  home_grid      TEXT,                             -- Maidenhead locator
  avatar_url     TEXT,
  bio            TEXT,                             -- short plain text, length-capped + tag-stripped server-side
  links          TEXT,                             -- JSON [{label,url}], http(s) only, capped count
  public_contact TEXT,                             -- opt-in public email; NULL = not shown
  profile_public INTEGER NOT NULL DEFAULT 1,       -- master show/hide
  -- APRS-IS announce of the user's finds: opt-in, gated on callsign control-verification
  announce_is    INTEGER NOT NULL DEFAULT 0,
  announce_tocall TEXT DEFAULT 'APZACG',           -- experimental tocall until one is registered
  -- the watch-alert email digest, the mandatory fallback for devices without push
  notify_digest  INTEGER NOT NULL DEFAULT 1,
  -- supporter recognition: a thank-you level and the hidden support prompt. Recognition only; no
  -- handler reads these to restrict anything.
  tier           TEXT    NOT NULL DEFAULT 'free',  -- free | supporter
  hide_nag       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_accounts_account_id ON accounts (account_id);
CREATE INDEX idx_accounts_email ON accounts (email);

-- Who holds a licence: one row per (account, base call), and a base call has at most one holder, so two
-- accounts can never claim the same licence. Every account holds the base of its active call here.
-- Whether control of the call is proven lives in callsign_verifications, never here.
CREATE TABLE account_callsigns (
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,                        -- base call only (no SSID)
  is_primary INTEGER NOT NULL DEFAULT 0,           -- the call the passkeys are bound to (login is by it)
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, callsign)
);
CREATE UNIQUE INDEX idx_account_callsigns_call ON account_callsigns (callsign);

-- Audit of active-call changes. `verified` is the verification state at the time of the change.
CREATE TABLE callsign_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,
  set_at     INTEGER NOT NULL,
  verified   INTEGER NOT NULL DEFAULT 0
);

-- WebAuthn passkeys, bound to the account's primary call.
CREATE TABLE credentials (
  id         TEXT PRIMARY KEY,                     -- credential id (base64url)
  callsign   TEXT NOT NULL,
  public_key BLOB NOT NULL,
  counter    INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                                 -- JSON authenticator transports
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cred_callsign ON credentials (callsign);

-- Short-lived challenges for passkey ceremonies.
CREATE TABLE auth_challenges (
  id         TEXT PRIMARY KEY,
  callsign   TEXT,
  kind       TEXT NOT NULL,                        -- webauthn_reg | webauthn_login | …
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Magic-link email tokens (register / login / recovery).
CREATE TABLE email_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  callsign   TEXT,                                 -- the desired callsign of a new-account register
  purpose    TEXT NOT NULL,                        -- register | login
  created_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- Device-independent UI preferences (theme, units, locale, pinned shack apps, basemap): one validated,
-- size-capped JSON blob per account. Guests keep the same settings in localStorage only.
CREATE TABLE account_prefs (
  account_id TEXT PRIMARY KEY,
  prefs      TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- The account lifecycle ledger: erasures and moves, driving "this callsign moved to <instance>"
-- redirects and downstream mirror purges.
CREATE TABLE account_events (
  callsign TEXT NOT NULL,
  action   TEXT NOT NULL,                          -- deleted | moved
  detail   TEXT,                                   -- e.g. the target instance of a move
  at       INTEGER NOT NULL,
  PRIMARY KEY (callsign, action)
);

-- Recognition flags keyed per account (supporter badge, …). Recognition only, never a feature gate.
CREATE TABLE entitlements (
  account_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);

-- Free keys that raise the per-IP read-API limit. Never paywalled; they carry no scope beyond the public
-- read surface.
CREATE TABLE api_keys (
  key          TEXT PRIMARY KEY,
  owner_call   TEXT,
  label        TEXT,
  rate_tier    TEXT NOT NULL DEFAULT 'free',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_api_keys_owner ON api_keys (owner_call);


-- ============================================================================================
-- 2. Callsign verification
-- ============================================================================================
-- Control-verification proves control of a licence and gates transmit, APRS-IS announce and
-- competitive credit. It never blocks logging, and it is distinct from the A/B/C find tiers.

-- The one store of whether a base call is control-verified (status 'verified'), and the pending on-air
-- challenge. Methods:
--   rf_heard  the holder transmitted `VERIFY <code>` and an attested site heard it on its own radio
--   ampr_dns  the holder published a code under their ARDC-delegated <call>.ampr.org name
--   lotw      the holder signed a nonce with their LoTW callsign-certificate key
--   operator  the instance operator confirmed an ADMIN_CALLSIGNS call with the operator secret
--   sysop     a sysop verified the call by hand, with a note saying how
-- The challenge is bound to the account that started it, and wrong guesses lock it after a cap, so the
-- short code cannot be brute-forced.
CREATE TABLE callsign_verifications (
  callsign    TEXT PRIMARY KEY,                    -- base call
  method      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',      -- pending | verified | failed
  challenge   TEXT,                                -- the one-time code to transmit
  account_id  TEXT,                                -- the account that started the challenge
  attempts    INTEGER NOT NULL DEFAULT 0,          -- wrong-code guesses
  created_at  INTEGER NOT NULL DEFAULT 0,          -- challenge issue time (expiry window)
  verified_at INTEGER,
  verified_by TEXT,                                -- who vouched: the attested site, or the sysop's call
  note        TEXT                                 -- the sysop's reason
);

-- Challenges of the methods that complete in the browser session (ampr_dns, lotw): one outstanding
-- challenge per base call and method, bound to the account that started it.
CREATE TABLE callsign_challenges (
  callsign   TEXT NOT NULL,                        -- base call
  method     TEXT NOT NULL,                        -- ampr_dns | lotw
  account_id TEXT NOT NULL,
  challenge  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,           -- failed completions; the challenge locks at the cap
  created_at INTEGER NOT NULL,
  PRIMARY KEY (callsign, method)
);
CREATE INDEX idx_callsign_challenges_account ON callsign_challenges (account_id);

-- Callsign validity from public licence registers (FCC ULS, ISED, ACMA, the Austrian and German
-- callsign lists). A row says only that a national register lists the call, whether that listing is
-- current, and until when. It is validity, never control-verification, and nothing is refused because
-- a call is missing (many countries publish no register). The rows hold public-register facts and
-- nothing else: the importer drops name, address, email and licence class on the operator's machine.
-- Each import of a source replaces that source's rows.
CREATE TABLE licence_registry (
  callsign   TEXT NOT NULL,                        -- the home call, no SSID
  source     TEXT NOT NULL,                        -- fcc | ised | acma | at | de | …
  status     TEXT NOT NULL CHECK (status IN ('licensed', 'expired')),
  expires_at INTEGER,                              -- when the register gives an expiry
  updated_at INTEGER NOT NULL,                     -- the import run that wrote the row
  PRIMARY KEY (callsign, source)
);
-- import bookkeeping: count this run's rows, then delete the rows an older run wrote
CREATE INDEX idx_licence_registry_source ON licence_registry (source, updated_at);

-- Device signing keys (Ed25519) bound to callsigns. A find signed by its logger's device key carries
-- portable, instance-independent authorship; a signed browser-bridge batch is attributed by it.
CREATE TABLE callsign_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign   TEXT NOT NULL,
  public_key TEXT NOT NULL,                        -- raw, base64url
  label      TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (callsign, public_key)
);
CREATE INDEX idx_callsign_keys_call ON callsign_keys (callsign);


-- ============================================================================================
-- 3. Caches & finds
-- ============================================================================================

CREATE TABLE caches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE NOT NULL,              -- AC-1234 (native) or the imported code
  owner_call    TEXT NOT NULL,                     -- ownership is call-based; hand-overs check the holder
  title         TEXT NOT NULL,
  type          TEXT NOT NULL,                     -- the CacheType enum (traditional | multi | aprs_living | audio | virtual | sota | pota | …)
  status        TEXT NOT NULL DEFAULT 'active',    -- active | disabled | archived
  difficulty    REAL DEFAULT 1.5,                  -- 1.0..5.0
  terrain       REAL DEFAULT 1.5,                  -- 1.0..5.0
  lat           REAL,                              -- final coordinates (stage 0 of a staged cache)
  lon           REAL,
  station_call  TEXT,                              -- aprs_living: the beaconing station that IS the cache
  hint          TEXT,
  description   TEXT,
  min_trust     TEXT,                              -- A | B; NULL = the site policy
  drive_in      INTEGER NOT NULL DEFAULT 0,        -- car-accessible
  country       TEXT,                              -- owner-set
  tags          TEXT,                              -- comma-joined, lowercased + deduped by the gateway
  rating_policy TEXT NOT NULL DEFAULT 'finders',   -- who may rate: finders (a verified find) | all | off
  rendezvous    INTEGER NOT NULL DEFAULT 0,        -- living cache: opt in to rendezvous with others
  -- how far the cache travels on the network, enforced at the feed before anything is signed:
  --   public (with description; the hint never federates) | unlisted (location/title only) | local-only
  fed_scope     TEXT NOT NULL DEFAULT 'public',
  -- the federation version: counted up on every change (trigger below), so two edits within one second
  -- are two versions. updated_at stays the feed page cursor and is never bumped ahead of the clock.
  fed_rev       INTEGER NOT NULL DEFAULT 0,
  -- heritage imports carry attribution and a deep link; a re-import updates in place
  source        TEXT NOT NULL DEFAULT 'native',    -- native | opencaching | sota | pota | …
  external_id   TEXT,                              -- OC code / SOTA ref / POTA ref
  source_url    TEXT,
  source_name   TEXT,                              -- attribution label, e.g. "SOTA", "Opencaching.de"
  imported_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_caches_geo ON caches (lat, lon);
CREATE INDEX idx_caches_status ON caches (status);
-- one row per (source, external_id), so a re-import updates instead of duplicating
CREATE UNIQUE INDEX idx_caches_external ON caches (source, external_id) WHERE external_id IS NOT NULL;

CREATE TRIGGER caches_fed_rev AFTER UPDATE ON caches
WHEN NEW.fed_rev = OLD.fed_rev
BEGIN
  UPDATE caches SET fed_rev = OLD.fed_rev + 1 WHERE id = NEW.id;
END;

-- Stages of a staged cache. Stage 0 is the public start; a later stage reveals once the finder unlocks
-- the prior one: by reaching its geofence, after its audio clue, or by presenting an NFC tag's secret
-- (tapped via WebNFC or typed). The secret is never returned by the read endpoints.
CREATE TABLE cache_stages (
  cache_id      INTEGER NOT NULL,
  stage_no      INTEGER NOT NULL,
  lat           REAL,
  lon           REAL,
  clue          TEXT,
  unlock        TEXT,                              -- geo | audio | open | nfc
  media_key     TEXT,                              -- audio clue in the media store
  radius_m      INTEGER NOT NULL DEFAULT 60,       -- the stage geofence
  unlock_secret TEXT,                              -- nfc: the tag's text/serial
  PRIMARY KEY (cache_id, stage_no)
);

-- The per-finder unlock ledger for staged caches.
CREATE TABLE stage_unlocks (
  callsign    TEXT NOT NULL,
  cache_id    INTEGER NOT NULL,
  stage_no    INTEGER NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (callsign, cache_id, stage_no)
);

-- Logs against a cache. Verification runs only for `found`; the tier says what corroborated it.
CREATE TABLE cache_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id            INTEGER NOT NULL,
  logger_call         TEXT NOT NULL,
  ts                  INTEGER NOT NULL,
  log_type            TEXT NOT NULL,               -- found | dnf | note | maintenance | enabled | disabled
  comment             TEXT,
  verified            INTEGER NOT NULL DEFAULT 0,
  tier                TEXT,                        -- A | B | C
  verify_method       TEXT,                        -- aprs_rf | app_geo | aprs_is | manual | none
  matched_position_id INTEGER,                     -- the position that corroborated it on this instance
  distance_m          REAL,
  corroborated_by     TEXT,                        -- the peer instance that corroborated a Tier-A find
  -- the IGate that did the RF corroboration, here or on a peer that revealed it, so the corroborator
  -- leaderboard credits the operator who actually heard the logger
  corroborator_igate  TEXT,
  -- authorship signed by the logger's device key (portable across instances)
  signer_key          TEXT,                        -- the device public key (base64url)
  author_sig          TEXT,                        -- signature over authorshipMessage(...)
  signed_at           INTEGER                      -- the client authorship time the signature covers
);
CREATE INDEX idx_logs_cache ON cache_logs (cache_id, ts DESC);
CREATE INDEX idx_logs_logger ON cache_logs (logger_call, ts DESC);
CREATE INDEX idx_logs_corroborator ON cache_logs (corroborator_igate);
-- A find is idempotent per (cache, logger): a racing or replayed POST can neither insert twice nor
-- double-count on the leaderboard (the handler uses INSERT OR IGNORE plus an already-found check).
CREATE UNIQUE INDEX idx_cache_logs_found_unique ON cache_logs (cache_id, logger_call) WHERE log_type = 'found';

-- 1–5 star ratings, one per callsign per cache (an upsert), gated by caches.rating_policy.
CREATE TABLE cache_ratings (
  cache_id INTEGER NOT NULL,
  callsign TEXT NOT NULL,
  stars    INTEGER NOT NULL,                       -- 1..5
  ts       INTEGER NOT NULL,
  PRIMARY KEY (cache_id, callsign)
);
CREATE INDEX idx_cache_ratings_cache ON cache_ratings (cache_id);

-- The per-cache index of owner-attached media (photos, audio, data files) held in the media store (the
-- server's filesystem). Size and type are limited at the handler.
CREATE TABLE cache_media (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id     INTEGER NOT NULL,
  media_key    TEXT NOT NULL,                      -- object-store key
  kind         TEXT NOT NULL,                      -- image | audio | file
  content_type TEXT NOT NULL,
  title        TEXT,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_cache_media_cache ON cache_media (cache_id);

-- Living-cache rendezvous: two opted-in living caches co-located within a short window both log the
-- meeting. A social record, kept outside the A/B/C find tiers, so two colluding stations cannot farm
-- verified finds by parking together.
CREATE TABLE rendezvous_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_a INTEGER NOT NULL,                        -- the living cache that just beaconed
  cache_b INTEGER NOT NULL,                        -- the co-located living cache it met
  call_a  TEXT NOT NULL,
  call_b  TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  lat     REAL,
  lon     REAL
);
CREATE INDEX idx_rendezvous_a ON rendezvous_log (cache_a, ts);
CREATE INDEX idx_rendezvous_b ON rendezvous_log (cache_b, ts);

-- Cache adoption: a sysop offers a native cache to the community (a withdrawn owner's, or an abandoned
-- one), a signed-in holder of a control-verified call requests it and the sysop approves, or the sysop
-- assigns it straight to such a holder.

-- The standing offer, one per cache. `note` is public: it says why the cache is up for adoption.
CREATE TABLE cache_adoption_offers (
  cache_id   INTEGER PRIMARY KEY,
  offered_by TEXT NOT NULL,                        -- the sysop's base call
  note       TEXT NOT NULL,
  offered_at INTEGER NOT NULL
);

-- A request to adopt. `callsign` becomes the owner; `account_id` held it when asking. `in_place` says
-- the requester confirms the container is at the site, which reactivates the cache on approval.
CREATE TABLE cache_adoption_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id     INTEGER NOT NULL,
  account_id   TEXT NOT NULL,
  callsign     TEXT NOT NULL,
  in_place     INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | declined | cancelled
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT
);
CREATE UNIQUE INDEX cache_adoption_requests_pending
  ON cache_adoption_requests (cache_id, account_id) WHERE status = 'pending';
CREATE INDEX cache_adoption_requests_account ON cache_adoption_requests (account_id);

-- The adoption audit trail: every offer, withdrawal, request, decision and hand-over. Erasure
-- anonymises a person's calls here and drops the notes.
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


-- ============================================================================================
-- 4. Community & notifications
-- ============================================================================================

CREATE TABLE achievements (callsign TEXT, badge TEXT, earned_at INTEGER, PRIMARY KEY (callsign, badge));
CREATE TABLE favorites    (callsign TEXT, cache_id INTEGER, PRIMARY KEY (callsign, cache_id));
CREATE TABLE watches      (callsign TEXT, cache_id INTEGER, PRIMARY KEY (callsign, cache_id));

-- Shareable map views: a permalink slug that restores centre, zoom, layers, filters and selection.
CREATE TABLE saved_views (
  slug       TEXT PRIMARY KEY,
  owner_call TEXT,
  name       TEXT,
  state      TEXT NOT NULL,                        -- JSON { center, zoom, layers, filters, selected }
  public     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_saved_views_owner ON saved_views (owner_call);

-- The watchlist: callsigns watched per account (it survives callsign changes).
CREATE TABLE watch_calls (
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,                        -- base call
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, callsign)
);
CREATE INDEX idx_watch_calls_call ON watch_calls (callsign);

-- In-app alerts: a watched call heard on the network or near a cache, an owner alert, an adoption
-- decision. Push and the email digest deliver on top; `notified` keeps a digest from re-sending.
CREATE TABLE watch_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  callsign   TEXT NOT NULL,
  kind       TEXT NOT NULL,                        -- heard | near_cache | …
  detail     TEXT,
  cache_id   INTEGER,
  lat        REAL,
  lon        REAL,
  ts         INTEGER NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0,
  notified   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_watch_alerts_acct ON watch_alerts (account_id, ts);

-- Web-push subscriptions (the enhancement over the mandatory email digest).
CREATE TABLE push_subs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT,
  auth       TEXT,
  topics     TEXT,                                 -- comma list: nearby | new_cache | watch
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, endpoint)
);


-- ============================================================================================
-- 5. Stations, positions & weather
-- ============================================================================================

-- Position history: the input to find verification. Firehose and browser-bridge positions are TTL'd
-- nightly; logger positions are kept longer so a find can still be verified.
--
-- `transport` is how the position reached the gateway (the provenance Transport: aprs-is, tnc,
-- browser-rf, axudp, axip, meshcom, meshtastic, or unknown for an ingest port the gateway does not
-- know), derived from the ingest port. The verify engine never branches on it; Tier A is gated on
-- first-party attestation, which only the on-air transports can carry.
CREATE TABLE positions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  heard_via  TEXT NOT NULL,                        -- rf | aprs_is
  transport  TEXT NOT NULL,
  igate_call TEXT,                                 -- the receiving site / gating IGate (independence checks)
  path       TEXT,                                 -- the stored APRS path incl. the q-construct
  source     TEXT,                                 -- firehose | browser-rf | …
  -- per-fix telemetry, so the shack can chart motion over time
  speed_kn   REAL,
  altitude_m REAL,
  course     INTEGER
);
CREATE INDEX idx_pos_call_ts ON positions (callsign, ts DESC);
-- the nightly firehose TTL and any source+time query range-scan this instead of the whole table
CREATE INDEX idx_pos_source_ts ON positions (source, ts);

-- The latest known state per station (the live map).
CREATE TABLE stations (
  callsign     TEXT PRIMARY KEY,
  symbol       TEXT,
  lat          REAL,
  lon          REAL,
  last_seen    INTEGER,
  course       INTEGER,
  speed_kn     INTEGER,
  altitude_m   INTEGER,
  comment      TEXT,
  source_call  TEXT                                -- the gating IGate
);
CREATE INDEX idx_stations_geo ON stations (lat, lon);

-- Raw per-station packet history for the shack: a short, hard-TTL ring of verbatim TNC2 frames. A
-- diagnostic, not a long-term log.
CREATE TABLE packets_recent (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign  TEXT NOT NULL,                         -- the source station
  ts        INTEGER NOT NULL,
  dst       TEXT,
  path      TEXT,                                  -- comma-joined digi path
  payload   TEXT,                                  -- the information field, verbatim
  heard_via TEXT,                                  -- rf | aprs_is
  port      TEXT
);
CREATE INDEX idx_packets_recent_cs ON packets_recent (callsign, ts);
CREATE INDEX idx_packets_recent_ts ON packets_recent (ts);

-- The APRS message log (firehose and shack), TTL-pruned and read per station.
CREATE TABLE messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER,
  from_call TEXT,
  to_call   TEXT,
  body      TEXT,
  ack       TEXT,
  direction TEXT                                   -- rx | tx
);
CREATE INDEX idx_messages_ts ON messages (ts);

-- Per-port RX/TX counters, bucketed by hour.
CREATE TABLE port_stats (port TEXT, ts INTEGER, rx INTEGER, tx INTEGER, PRIMARY KEY (port, ts));

-- Weather readings, observational only: they never touch the find tiers. Sources are RF and APRS-IS
-- weather beacons and direct PWS pushes (stored under the station the push key names).
CREATE TABLE sensor_readings (
  station        TEXT,
  ts             INTEGER,
  temp_c         REAL,
  humidity       REAL,
  pressure_hpa   REAL,
  wind_dir       INTEGER,
  wind_kn        REAL,
  gust_kn        REAL,
  rain_mm        REAL,                             -- last hour
  rain_24h_mm    REAL,
  luminosity_wm2 REAL,
  source         TEXT,                             -- rf | aprs_is | ecowitt | wu | serial | cwop
  PRIMARY KEY (station, ts)
);

-- The stations an account operates (a home PWS, a mountain-top digipeater, an IGate, a node), each with
-- its own callsign+SSID, an explicit location and roles. An APRS fix from a registered call keeps its
-- location live.
CREATE TABLE account_stations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  callsign    TEXT NOT NULL,                       -- full callsign incl. SSID, e.g. OE8APR-1
  lat         REAL,
  lon         REAL,
  symbol      TEXT,                                -- APRS symbol (the role default when unset)
  description TEXT,
  roles       TEXT NOT NULL DEFAULT '',            -- csv subset of: weather,digipeater,igate,node,repeater
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_account_stations_call ON account_stations (callsign);
CREATE INDEX idx_account_stations_acct ON account_stations (account_id);

-- PWS push keys, one per weather station in the operator's registry: a key feeds its station at the station's
-- own location (the home grid when the station has none). Weather TX (an
-- APRS-IS beacon or the CWOP relay) is off by default, gated on callsign control-verification, and
-- throttled.
CREATE TABLE wx_keys (
  key         TEXT PRIMARY KEY,
  callsign    TEXT NOT NULL,                       -- base call
  account_id  TEXT,
  station_id  INTEGER,                             -- account_stations.id; a key without one feeds nothing
  tx_is       INTEGER NOT NULL DEFAULT 0,          -- APRS-IS weather beacon
  tx_cwop     INTEGER NOT NULL DEFAULT 0,          -- CWOP relay
  last_beacon INTEGER,                             -- beacon throttle
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);
CREATE INDEX idx_wx_keys_call ON wx_keys (callsign);


-- ============================================================================================
-- 6. Radio commands, outbox & remote boxes
-- ============================================================================================

-- The APRS-IS / CWOP outbox. The gateway enqueues; the ingest box, the only holder of the uplink,
-- publishes in third-party format. Status and messages only, never positions, so nothing here can feed
-- verification.
CREATE TABLE aprs_outbox (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  src_call TEXT NOT NULL,                          -- the user's verified callsign (inner source)
  tocall   TEXT NOT NULL DEFAULT 'APZACG',
  kind     TEXT NOT NULL,                          -- status | message | …
  payload  TEXT NOT NULL,
  target   TEXT NOT NULL DEFAULT 'is',             -- is | cwop (drain routing)
  status   TEXT NOT NULL DEFAULT 'queued',         -- queued | sent | failed
  sent_at  INTEGER
);
CREATE INDEX idx_outbox_status ON aprs_outbox (status, ts);

-- Commands sent as radio text messages to the instance's service call (FOUND / DNF / NOTE / HELP),
-- whatever transport carried them. A command that arrived only over the internet waits as `pending`
-- until the signed-in player confirms it; its find is scored at the time the message was sent and the
-- score is kept here, so the confirmation does not depend on positions pruned since.
CREATE TABLE radio_commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_call  TEXT NOT NULL,                        -- sender as heard, with SSID
  account_id TEXT,                                 -- the holder of the verified base call (NULL when unresolved)
  command    TEXT NOT NULL,                        -- found | dnf | note | help | invalid
  cache_id   INTEGER,
  cache_code TEXT,
  body       TEXT,                                 -- log text after the cache code
  raw_text   TEXT NOT NULL,                        -- the message text as received (duplicate detection)
  msg_no     TEXT,                                 -- APRS message number, when the sender numbered it
  port       TEXT,                                 -- the ingest port that carried it
  heard_via  TEXT,
  igate_call TEXT,
  trusted    INTEGER NOT NULL DEFAULT 0,           -- heard at an attested RF site, or signed by the sender's device key
  status     TEXT NOT NULL,                        -- logged | pending | rejected | help | discarded | expired
  reason     TEXT,                                 -- why a command was rejected
  score      TEXT,                                 -- JSON find score at message time (pending finds)
  log_id     INTEGER,                              -- cache_logs.id once logged
  sent_at    INTEGER NOT NULL,                     -- the message timestamp
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  replied_at INTEGER                               -- when a text reply was queued (per-destination reply limit)
);
CREATE INDEX idx_radio_commands_sender ON radio_commands (from_call, sent_at);
CREATE INDEX idx_radio_commands_account ON radio_commands (account_id, status);

-- Remote station control: a per-box command queue the operator's ingest box pulls over its own
-- outbound connection (no inbound ports). Transmit commands are gated on callsign control-verification.
CREATE TABLE box_commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id     TEXT NOT NULL,
  callsign   TEXT,                                 -- the licensed call the command operates as
  kind       TEXT NOT NULL,                        -- beacon | message | wx_beacon | igate | digi | tx | status
  payload    TEXT,                                 -- JSON command args
  status     TEXT NOT NULL DEFAULT 'queued',       -- queued | sent | done | failed
  result     TEXT,                                 -- the box-reported result or error
  sig        TEXT,                                 -- Ed25519 signature for the licensed call (box-verified)
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  acked_at   INTEGER
);
CREATE INDEX idx_box_commands_poll ON box_commands (box_id, status, created_at);

-- The account that controls a box, so no signed-in user can key another operator's radio. The box
-- itself still leases and acks with the ingest secret.
CREATE TABLE boxes (
  box_id     TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A box links to an account only by a one-time pairing code the box obtains with its ingest secret and
-- shows its operator. Only a hash of the code is kept, and only until it expires or is used.
CREATE TABLE box_pairings (
  box_id     TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,                        -- SHA-256 hex of the normalised code
  expires_at INTEGER NOT NULL
);

-- What each box can transmit, as it reports on every command poll. Answers to radio commands go back
-- through the box that heard them only while it polls and can send; otherwise through the outbox.
CREATE TABLE box_status (
  box_id    TEXT PRIMARY KEY,
  caps      TEXT NOT NULL,                         -- JSON {tx: boolean, rf: boolean, meshcom: string[]}
  last_seen INTEGER NOT NULL
);


-- ============================================================================================
-- 7. BBS & packet node
-- ============================================================================================

-- The store-and-forward message base. Personal mail is held until the addressee is heard, then
-- forwarded as an APRS message with ack tracking and retry. Bulletins are deduped by BID across
-- forwarding. The format (P/B/T type, BID/MID) is MBL/FBB-compatible, so a connected-mode gateway can
-- bridge. Replies chain into threads: `thread_id` is the root message's id.
CREATE TABLE bbs_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bid        TEXT UNIQUE,                          -- e.g. "42_oe.aprscaching.org"
  type       TEXT NOT NULL,                        -- P personal | B bulletin | T NTS traffic
  from_call  TEXT NOT NULL,
  to_call    TEXT NOT NULL,                        -- callsign (P) or category, e.g. ALL / SYSOP (B)
  subject    TEXT,
  body       TEXT NOT NULL,
  posted_at  INTEGER NOT NULL,
  expires_at INTEGER,
  origin     TEXT NOT NULL DEFAULT 'local',        -- local, or the instance a bulletin was mirrored from
  read_at    INTEGER,                              -- personal: when the recipient read it
  reply_to   INTEGER,
  thread_id  INTEGER
);
CREATE INDEX idx_bbs_to ON bbs_messages (to_call, type, posted_at DESC);
CREATE INDEX idx_bbs_thread ON bbs_messages (thread_id, posted_at);

-- Per-recipient delivery state of the APRS store-and-forward path.
CREATE TABLE bbs_delivery (
  msg_id       INTEGER NOT NULL,
  to_call      TEXT NOT NULL,
  line_no      INTEGER,                            -- the APRS message number {NN on the wire
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  acked_at     INTEGER,
  status       TEXT NOT NULL DEFAULT 'held',       -- held | sent | acked | expired
  PRIMARY KEY (msg_id, to_call)
);
CREATE INDEX idx_bbs_delivery_call ON bbs_delivery (to_call, status);

-- The forward table: a hierarchical route token (or '*' catch-all) maps to a partner and transport.
CREATE TABLE bbs_forward_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  partner    TEXT NOT NULL,
  route      TEXT NOT NULL,                        -- OE, EU, DB0XYZ, … or '*'
  transport  TEXT NOT NULL DEFAULT 'ip-fed',       -- ip-fed | rf-fbb | axip
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_fwd_enabled ON bbs_forward_rules (enabled);
-- bulletin federation is the default catch-all forwarding partner
INSERT INTO bbs_forward_rules (partner, route, transport, enabled, created_at) VALUES ('ip-fed', '*', 'ip-fed', 1, 0);

-- White pages: a callsign's home BBS, steering personal mail.
CREATE TABLE white_pages (
  callsign   TEXT PRIMARY KEY,
  home_bbs   TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- FBB forwarding partners: who to connect to, how (a connect script through nodes), when (interval and
-- UTC time bands) and what to exchange. A forward rule names a partner; the partner row says how to
-- reach it.
CREATE TABLE bbs_partners (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  call            TEXT NOT NULL UNIQUE,            -- partner BBS callsign (SSID-bearing)
  ha              TEXT,                            -- hierarchical address, e.g. OE8XBM.OE.EU
  connect_script  TEXT NOT NULL DEFAULT '',        -- "C NODE1" / "C 3 DB0XYZ" lines (\n-separated)
  proto           TEXT NOT NULL DEFAULT 'rf-fbb',  -- rf-fbb | axudp | ip-fed
  interval_min    INTEGER NOT NULL DEFAULT 30,     -- poll interval in minutes (0 = manual only)
  timebands       TEXT NOT NULL DEFAULT '',        -- UTC hour windows "0-6,22-23" ('' = any time)
  request_reverse INTEGER NOT NULL DEFAULT 1,      -- ask the partner to reverse-forward
  msgtypes        TEXT NOT NULL DEFAULT 'PBT',     -- which types we send
  max_block       INTEGER NOT NULL DEFAULT 5,      -- proposals per FBB block (spec cap 5)
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_partners_enabled ON bbs_partners (enabled);

-- Which BIDs went to which partner, so the forwarding scheduler never re-offers a message (FBB BID
-- dedup covers the inbound side).
CREATE TABLE bbs_forward_log (
  partner      TEXT NOT NULL,                      -- bbs_partners.call
  bid          TEXT NOT NULL,
  forwarded_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner, bid)
);

-- The NET/ROM NODES table (best route per destination) and the per-port MHeard list.
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


-- ============================================================================================
-- 8. Federation
-- ============================================================================================
-- Records are signed at serve time and namespaced by global id (`<instance>:<kind>:<id>`); a peer may
-- only serve, overwrite or tombstone ids in its own namespace. Mirrored rows are display data: never
-- treated as our own and never re-published in our feeds.

-- Peers. A peer's identity is its instance id and published signing keys; its addresses are data.
-- `url` is the row identity and the peer's https address; `endpoints` adds a typed endpoint set. Trust
-- is operator-set, never derived from transport:
--   trusted   operator-curated; counts toward the corroboration quorum and the default map
--   unvetted  discovered, registered or submitted; mirrored but flagged, excluded from verification
--   blocked   never fetched
CREATE TABLE fed_peers (
  url                 TEXT PRIMARY KEY,
  instance            TEXT,                        -- the instance id from its descriptor
  endpoints           TEXT,                        -- JSON [{transport, address, priority, verifiedVia}], transport ∈ https | 44net | ax25 | netrom | bbs
  verified_via        TEXT,                        -- how the call/name binding was established (e.g. ardc-lot); identity only
  enabled             INTEGER NOT NULL DEFAULT 1,
  trust               TEXT NOT NULL DEFAULT 'unvetted', -- trusted | unvetted | blocked
  added_via           TEXT,                        -- manual | discovered | registry | submitted | 44net
  approved_at         INTEGER,                     -- when an operator trusted it
  -- keys: the pin moves only along a verified rotation chain. accept_keys is the set its frames verify
  -- under, as JSON [{x, until?}]; a key past its `until` stays listed so no later descriptor revives it.
  public_key          TEXT,                        -- the pinned Ed25519 key (raw, base64url)
  accept_keys         TEXT,
  -- per-feed pull cursors; caches and bulletins page by (timestamp, id) because a timestamp repeats
  caches_cursor       INTEGER NOT NULL DEFAULT 0,
  caches_cursor_id    INTEGER,
  finds_cursor        INTEGER NOT NULL DEFAULT 0,
  keys_cursor         INTEGER NOT NULL DEFAULT 0,
  tombstones_cursor   INTEGER NOT NULL DEFAULT 0,
  moves_cursor        INTEGER NOT NULL DEFAULT 0,
  bulletins_cursor    INTEGER NOT NULL DEFAULT 0,
  bulletins_cursor_id INTEGER,
  -- sync health and reputation (operator promote/demote inputs)
  last_sync           INTEGER,                     -- the last attempt
  last_ok             INTEGER,                     -- the last success (lag = now - last_ok)
  last_error          TEXT,
  sync_ok             INTEGER NOT NULL DEFAULT 0,
  sync_err            INTEGER NOT NULL DEFAULT 0,
  mirrored_total      INTEGER NOT NULL DEFAULT 0,
  last_counts         TEXT,                        -- JSON per-feed counts of the last sync
  rep_confirmed       INTEGER NOT NULL DEFAULT 0,  -- corroborations later confirmed
  rep_failed          INTEGER NOT NULL DEFAULT 0   -- corroborations contradicted
);
-- An instance id names one live peer: a second non-blocked row claiming it is an impostor or a stale
-- address, and the operator decides which by blocking or deleting it.
CREATE UNIQUE INDEX fed_peers_instance_live ON fed_peers (instance) WHERE trust != 'blocked';

-- The last good signed registry per authority key: `max_at` rejects a replayed older document, and
-- `doc` keeps enforcing its bindings while the registry is unreachable.
CREATE TABLE fed_registry_state (
  authority_key TEXT PRIMARY KEY,
  max_at        INTEGER NOT NULL,
  doc           TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);

-- The highest version applied per mirrored global id. A frame applies only when its version is
-- strictly greater, so a replayed older record, or a different record at the same version, never rolls
-- a mirror back.
CREATE TABLE fed_versions (
  gid        TEXT PRIMARY KEY,
  origin     TEXT NOT NULL,
  v          INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

-- The rendezvous relay queue: a hub holds queries addressed to a NAT'd spoke, which leases them over its
-- outbound poll and posts the signed answer back. A query belongs to whoever queued it: the hash of the
-- ticket handed back at enqueue reads the answer, and `requester` keys the per-requester cap. Rows are
-- ephemeral and TTL'd nightly.
CREATE TABLE fed_relay_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance    TEXT NOT NULL,                       -- the spoke the query is addressed to
  kind        TEXT NOT NULL,                       -- feed | corroborate
  params      TEXT,                                -- JSON query params
  status      TEXT NOT NULL DEFAULT 'queued',      -- queued | leased | answered
  answer      TEXT,                                -- JSON RelayResult
  ticket_hash TEXT,
  requester   TEXT,
  created_at  INTEGER NOT NULL DEFAULT 0,
  leased_at   INTEGER,
  answered_at INTEGER
);
CREATE INDEX idx_fed_relay_lease ON fed_relay_queue (instance, status, created_at);

-- Mirrored caches, finds and key bindings (the key bindings let consumers check author signatures
-- offline).
CREATE TABLE remote_caches (
  global_id    TEXT PRIMARY KEY,                   -- e.g. oe.aprscaching.org:cache:42
  origin       TEXT NOT NULL,
  code         TEXT,
  owner_call   TEXT,
  title        TEXT,
  type         TEXT,
  status       TEXT,
  difficulty   REAL,
  terrain      REAL,
  lat          REAL,
  lon          REAL,
  station_call TEXT,
  source       TEXT,
  external_id  TEXT,
  hint         TEXT,
  description  TEXT,
  min_trust    TEXT,
  created_at   INTEGER,
  updated_at   INTEGER,
  mirrored_at  INTEGER NOT NULL
);
CREATE INDEX idx_remote_caches_geo ON remote_caches (lat, lon);

CREATE TABLE remote_finds (
  global_id       TEXT PRIMARY KEY,
  origin          TEXT NOT NULL,
  cache_global_id TEXT,
  cache_code      TEXT,
  logger_call     TEXT,
  ts              INTEGER,
  log_type        TEXT,
  verified        INTEGER,
  tier            TEXT,
  verify_method   TEXT,
  distance_m      REAL,
  comment         TEXT,
  mirrored_at     INTEGER NOT NULL
);
CREATE INDEX idx_remote_finds_cache ON remote_finds (cache_global_id);

CREATE TABLE remote_keys (
  global_id   TEXT PRIMARY KEY,                    -- origin:key:rowid
  origin      TEXT NOT NULL,
  callsign    TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  verified    INTEGER,
  created_at  INTEGER,
  mirrored_at INTEGER NOT NULL
);
CREATE INDEX idx_remote_keys_call ON remote_keys (callsign);

-- GDPR delete propagation. A delete here must purge the PII-bearing copies on peers, and the append-only
-- finds cursor never re-serves an anonymised row, so the origin emits a signed, PII-free tombstone
-- naming the removed record's global id. Tombstones are kept permanently on both sides: they hold only
-- ids, and a mirror consults them on every upsert so deleted data is never re-mirrored.
CREATE TABLE tombstones (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,     -- the feed cursor (the uuid is not ordered)
  id        TEXT NOT NULL UNIQUE,                  -- uuid
  kind      TEXT NOT NULL,                         -- account | find | cache | …
  target_id TEXT NOT NULL,                         -- the removed record's global id (never a callsign)
  origin    TEXT NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX idx_tombstones_ts ON tombstones (ts);

CREATE TABLE remote_tombstones (
  target_id   TEXT PRIMARY KEY,
  origin      TEXT NOT NULL,                       -- the instance that emitted it
  kind        TEXT NOT NULL,
  ts          INTEGER NOT NULL,                    -- emit time carried from the tombstone
  mirrored_at INTEGER NOT NULL
);

-- Account moves. The target instance publishes a signed move record carrying the mover's proof: the
-- device-key assertion signed on import and bound to the target. A mirror keeps a move only when that
-- proof verifies under a key it knows for the callsign independently of the claimant, and orders moves
-- by the proof's signing time, so an old proof re-announced later never takes an account back.
CREATE TABLE account_moves (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT, -- the feed cursor
  callsign      TEXT NOT NULL,
  from_instance TEXT,
  to_instance   TEXT NOT NULL,                     -- this instance, at publish time
  ts            INTEGER NOT NULL,
  proof_key     TEXT,
  proof_sig     TEXT,
  proof_at      INTEGER
);
CREATE INDEX idx_account_moves_call ON account_moves (callsign);

-- The latest known home per callsign, mirrored from peers. `global_id` lets the origin's tombstone purge
-- it when the account is erased.
CREATE TABLE remote_account_moves (
  callsign      TEXT PRIMARY KEY,
  from_instance TEXT,
  to_instance   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  origin        TEXT NOT NULL,                     -- the instance that announced the move
  mirrored_at   INTEGER NOT NULL,
  global_id     TEXT,
  proof_at      INTEGER
);


-- ============================================================================================
-- 9. Operations
-- ============================================================================================

-- The public transparency ledger: what came in and how it was spent, per bucket.
CREATE TABLE ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  direction    TEXT NOT NULL,                      -- in | out
  bucket       TEXT NOT NULL,                      -- development | hosting | operation | peer_reimbursement
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'EUR',
  note         TEXT,
  source       TEXT                                -- liberapay | kofi | patreon | opencollective | manual
);
CREATE INDEX idx_ledger_ts ON ledger (ts);

-- Durable fixed-window rate-limit counters. An in-memory limiter forgets on restart, so counters live
-- here: one row per key, rolled over
-- in place, expired windows pruned nightly. reset_at is unix milliseconds.
CREATE TABLE rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
