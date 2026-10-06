-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The aprscaching schema. The Node (better-sqlite3), Bun (bun:sqlite) and desktop servers apply it to
-- a fresh database at boot. It holds no virtual tables (rtree, FTS), so it stays portable across SQLite
-- builds: spatial lookups use plain (lat, lon) indexes and search is LIKE-based.
--
-- Times are unix seconds unless a column says otherwise. Callsigns are stored uppercase; a "base call"
-- is the licence without an SSID.
--
-- Domains, in order:
--   1. Accounts & identity          7. BBS & packet node
--   2. Callsign verification        8. Federation
--   3. Caches & finds               9. Moderation
--   4. Community & notifications   10. Shack tools
--   5. Stations, positions & weather 11. Operations
--   6. Radio services, outbox & ingest boxes


-- ============================================================================================
-- 1. Accounts & identity
-- ============================================================================================
-- An account is a person. `account_id` is the durable identity; `accounts.callsign` is the active
-- operating call, a mutable attribute. A person holds one or more base calls (account_callsigns), and
-- switching between held calls never re-verifies. Profiles are thin and opt-in, and every column here
-- is inside the GDPR export/erase tools. A new account shares nothing it did not choose to: the public
-- profile, the email digest, APRS-IS announce and the near-cache radio message all start off.

CREATE TABLE accounts (
  callsign       TEXT PRIMARY KEY,                 -- the active operating call (may carry an SSID)
  account_id     TEXT NOT NULL,                    -- durable identity; every account row carries one
  email          TEXT,                             -- confirmed recovery / magic-link address (never shown)
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
  profile_public INTEGER NOT NULL DEFAULT 0,       -- master show/hide of the fields above; off until the owner shows them
  -- APRS-IS announce of the user's finds: opt-in, gated on callsign control-verification
  announce_is    INTEGER NOT NULL DEFAULT 0,
  announce_tocall TEXT DEFAULT 'APZACG',           -- experimental tocall until one is registered
  -- the watch-alert email digest, the fallback for devices without push: off until the user turns it on
  notify_digest  INTEGER NOT NULL DEFAULT 0,
  -- supporter recognition: a thank-you level and the hidden support prompt. Recognition only; no
  -- handler reads these to restrict anything.
  tier           TEXT    NOT NULL DEFAULT 'free',  -- free | supporter
  hide_nag       INTEGER NOT NULL DEFAULT 0,
  near_radio     INTEGER NOT NULL DEFAULT 0,       -- the service call messages the user's stations near a cache
  -- an address given at passkey registration waits here until its owner opens the confirmation link; only
  -- a confirmed address (`email`) signs in, receives mail or counts as a way back into the account
  pending_email  TEXT
);
CREATE UNIQUE INDEX idx_accounts_account_id ON accounts (account_id);
CREATE INDEX idx_accounts_email ON accounts (email);
-- One account per confirmed address: a magic link names exactly one account. Every writer stores the
-- address lower-cased; the index compares lower-cased too, so a stray capital can never open a second
-- account on the same mailbox.
CREATE UNIQUE INDEX idx_accounts_email_unique ON accounts (lower(email)) WHERE email IS NOT NULL;

-- Who holds a licence: one row per (account, base call), and a base call has at most one holder, so two
-- accounts can never claim the same licence. Every account holds the base of its active call here.
-- Whether control of the call is proven lives in callsign_verifications, never here. A call under a
-- suspension in force never gets here (trigger account_callsigns_suspended, under Moderation).
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

-- WebAuthn passkeys. A passkey belongs to the account that registered it, not to the call string it was
-- registered under: the account keeps its passkeys when its active call changes, and a passkey signs in
-- from any call (or SSID) the account holds.
CREATE TABLE credentials (
  id         TEXT PRIMARY KEY,                     -- credential id (base64url)
  callsign   TEXT NOT NULL,                        -- the call the passkey was registered under
  public_key BLOB NOT NULL,
  counter    INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                                 -- JSON authenticator transports
  created_at INTEGER NOT NULL,
  account_id TEXT
);
CREATE INDEX idx_cred_callsign ON credentials (callsign);
CREATE INDEX idx_cred_account ON credentials (account_id);

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

-- Read-API keys, each owned by a signed-in account. The instance stores only the SHA-256 of each key, so a
-- copy of the database holds no usable key; `prefix` is enough for the owner and the sysop to tell keys
-- apart. A key raises the read API's rate limit and gates nothing; keys are never paywalled.
CREATE TABLE api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash     TEXT NOT NULL UNIQUE,                -- hex SHA-256 of the full key
  prefix       TEXT NOT NULL,                       -- the key's first 12 characters, shown in lists
  account_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  rate_tier    TEXT NOT NULL DEFAULT 'free',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_api_keys_account ON api_keys (account_id);


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
-- challenge per base call, method and starter, so a claimant's challenge and the holder's never replace
-- each other.
CREATE TABLE callsign_challenges (
  callsign   TEXT NOT NULL,                        -- base call
  method     TEXT NOT NULL,                        -- ampr_dns | lotw
  account_id TEXT NOT NULL,                        -- the starting account, or `claim:<id>` for a claim
  challenge  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,           -- failed completions; the challenge locks at the cap
  created_at INTEGER NOT NULL,
  PRIMARY KEY (callsign, method, account_id)
);
CREATE INDEX idx_callsign_challenges_account ON callsign_challenges (account_id);

-- Taking over a held call by proof of control. A call held by an account that never proved control of it
-- is not that account's for good: its licensee may open a claim and complete any control-verification
-- method for the call. The claim carries a bearer token (stored only as its hash) so a person without an
-- account can claim their own call at sign-up; a signed-in claimant's account is named on the claim. On
-- success the call moves to the claimant, verified.
CREATE TABLE callsign_claims (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,              -- SHA-256 (base64url) of the claimant's bearer token
  callsign      TEXT NOT NULL,                     -- base call
  account_id    TEXT,                              -- the claimant's account; a sign-up claim names the new one on success
  signup        INTEGER NOT NULL DEFAULT 0,        -- opened without an account: success opens one
  holder_id     TEXT,                              -- the account that held the call when the claim opened (NULL: nobody)
  status        TEXT NOT NULL DEFAULT 'open',      -- open | done | refused
  -- the on-air code of the claim, kept apart from the holder's own challenge so neither replaces the other
  rf_code       TEXT,
  rf_attempts   INTEGER NOT NULL DEFAULT 0,
  rf_created_at INTEGER,
  method        TEXT,                              -- the verification method that completed the claim
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  collected     INTEGER NOT NULL DEFAULT 0         -- a sign-up claim's session was handed out
);
CREATE INDEX idx_callsign_claims_call ON callsign_claims (callsign, status);
CREATE INDEX idx_callsign_claims_account ON callsign_claims (account_id);

-- Who held a call, and when that changed outside the account's own hands: a claim by proof of control, or a
-- sysop releasing the call from an account. `actor` is the verification method of a claim or the sysop's call.
CREATE TABLE callsign_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign     TEXT NOT NULL,                      -- base call
  action       TEXT NOT NULL,                      -- claimed | released
  from_account TEXT,                               -- the account that lost the call (NULL: nobody held it)
  to_account   TEXT,                               -- the account that took it (NULL on a release)
  actor        TEXT NOT NULL,
  note         TEXT,                               -- the sysop's reason for a release
  at           INTEGER NOT NULL
);
CREATE INDEX idx_callsign_events_call ON callsign_events (callsign, id);
CREATE INDEX idx_callsign_events_from ON callsign_events (from_account);
CREATE INDEX idx_callsign_events_to ON callsign_events (to_account);

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
-- Keys travel per peer, not per origin, but are numbered like the per-origin records: the keys cursor
-- pages by fed_seq, and the key's global id is `<instance>:key:<fed_seq>`, so a key registered after a
-- restore reaches every peer (trigger callsign_keys_fed_seq, under Federation).
CREATE TABLE callsign_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign   TEXT NOT NULL,
  public_key TEXT NOT NULL,                        -- raw, base64url
  label      TEXT,
  created_at INTEGER NOT NULL,
  fed_seq    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (callsign, public_key)
);
CREATE INDEX idx_callsign_keys_call ON callsign_keys (callsign);
CREATE INDEX idx_callsign_keys_fed_seq ON callsign_keys (fed_seq);


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
  -- the federation version, the record's signed `v`: every insert and every change takes the next number of
  -- the `cache` counter in fed_seq (triggers under Federation), so two edits within one second are two
  -- versions. updated_at stays the feed page cursor and is never bumped ahead of the clock.
  fed_rev       INTEGER NOT NULL DEFAULT 0,
  -- heritage imports carry attribution and a deep link; a re-import updates in place
  source        TEXT NOT NULL DEFAULT 'native',    -- native | opencaching | sota | pota | …
  external_id   TEXT,                              -- OC code / SOTA ref / POTA ref
  source_url    TEXT,
  source_name   TEXT,                              -- attribution label, e.g. "SOTA", "Opencaching.de"
  imported_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- what an imported place's source asks to be shown with it: the author's name at the source (an
  -- OpenCaching user name), and the source's attribution note as a JSON array of text parts, each with an
  -- optional http(s) link, so the cache detail shows it without rendering source HTML. NULL for native
  -- caches and for sources that supply neither.
  source_owner       TEXT,
  source_attribution TEXT,
  -- a cache the sysop removed: archived, hidden from everyone but its owner and the sysop, and closed to the
  -- owner's edits. The row stays so its finds and adoption trail keep their cache.
  removed_at     INTEGER,
  removed_reason TEXT,
  -- the number the cache was made with, its global id `<instance>:cache:<fed_id>`. Row ids come back with a
  -- backup and are handed out again, sequence numbers are not, so a new cache never takes the global id of
  -- one the peers hold or deleted.
  fed_id         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_caches_geo ON caches (lat, lon);
CREATE INDEX idx_caches_status ON caches (status);
-- one row per (source, external_id), so a re-import updates instead of duplicating
CREATE UNIQUE INDEX idx_caches_external ON caches (source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_caches_fed_rev ON caches (fed_rev);
CREATE INDEX idx_caches_fed_id ON caches (fed_id);

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
  -- what unlocking an NFC stage reveals, sealed under its tag code (packages/shared stageseal.ts), so an
  -- offline pack can carry it and the finder's phone opens it by scanning the tag. JSON; NULL for other
  -- unlock kinds and for codes too weak to seal (those stages stay online-only).
  sealed        TEXT,
  -- the size of the audio clue, so the media limits (per cache, per account, per instance) count it beside
  -- the gallery
  media_bytes   INTEGER,
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

-- Where each coordinate of a cache stood when the cache took its first find. From then on an owner moves that
-- coordinate at most CACHE_MOVE_LIMIT_M from its pin, so past finds keep pointing to the place the finders
-- visited. `stage_no` -1 is the cache's own coordinates; 0 and up are cache_stages.stage_no, carried along when
-- the owner renumbers the stages. A living cache's own coordinates follow its station and are never pinned.
CREATE TABLE cache_place_pins (
  cache_id  INTEGER NOT NULL,
  stage_no  INTEGER NOT NULL,
  lat       REAL NOT NULL,
  lon       REAL NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (cache_id, stage_no)
);

-- Logs against a cache. Verification runs only for `found`; the tier says what corroborated it.
CREATE TABLE cache_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_id            INTEGER NOT NULL,
  logger_call         TEXT NOT NULL,
  -- the find time: the signed field time when the signature's time passes the bounds
  -- (workers/gateway/src/fieldtime.ts), so a find queued offline is verified at the moment it was made;
  -- otherwise the receive time
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
  signed_at           INTEGER,                     -- the client authorship time the signature covers
  corroborated_later_at INTEGER,                   -- when a find reached Tier A through a retry; NULL when settled at logging
  received_at         INTEGER,                     -- when the gateway received the log
  -- why ts is the receive time instead of the signed field time:
  -- future | too_old | before_cache | before_key | unsigned (an unsigned log the client queued)
  field_time_rejected TEXT,
  -- a finder's "needs maintenance" flag on a found or did-not-find log. The cache shows it until its owner
  -- posts a maintenance log (or enables the cache again) after it; the owner hears of each flag in the app.
  needs_maintenance   INTEGER NOT NULL DEFAULT 0,
  -- the find's number, its signed `v` and its global id `<instance>:find:<fed_seq>` (trigger
  -- cache_logs_fed_seq, under Federation)
  fed_seq             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_logs_cache ON cache_logs (cache_id, ts DESC);
CREATE INDEX idx_logs_logger ON cache_logs (logger_call, ts DESC);
CREATE INDEX idx_logs_corroborator ON cache_logs (corroborator_igate);
-- A find is idempotent per (cache, logger): a racing or replayed POST can neither insert twice nor
-- double-count on the leaderboard (the handler uses INSERT OR IGNORE plus an already-found check).
CREATE UNIQUE INDEX idx_cache_logs_found_unique ON cache_logs (cache_id, logger_call) WHERE log_type = 'found';
CREATE INDEX idx_cache_logs_fed_seq ON cache_logs (fed_seq);

-- A found log that missed Tier A only because trusted peers could not be reached is asked again: the same
-- question, to those peers only, a few times within 72 hours (corroborate_retry.ts). A row goes when the
-- find reaches Tier A, a peer says no, the attempts run out, or its log goes.
CREATE TABLE corroboration_retries (
  log_id    INTEGER PRIMARY KEY REFERENCES cache_logs(id) ON DELETE CASCADE,
  query     TEXT NOT NULL,  -- JSON CorroborationQuery, asked again verbatim
  peers     TEXT NOT NULL,  -- JSON [url]: the trusted peers not reached last time
  hits      TEXT NOT NULL,  -- JSON [{url, ev}]: trusted evidence already in hand
  logged_at INTEGER NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 0,
  next_at   INTEGER NOT NULL,
  -- questions waiting in a hub's relay queue for trusted peers nobody can dial, read on the relay timer
  -- until answered: JSON [{url, instance, hub, id, ticket, nonce, queryHash, askedAt}]
  relayed   TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_corr_retry_next ON corroboration_retries(next_at);

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
  created_at   INTEGER NOT NULL,
  -- a small copy of an image, stored beside it: the gallery and an offline pack's thumbnails load it instead
  -- of the image as published. The uploader's browser makes it (the instance has no image resizer on every
  -- runtime); NULL until one is stored.
  thumb_key    TEXT,
  thumb_bytes  INTEGER
);
CREATE INDEX idx_cache_media_cache ON cache_media (cache_id);
-- Media objects whose index rows are gone and whose objects still wait to leave the store. An erasure or a removal
-- queues them in the same transaction that drops the rows, then deletes the objects; the nightly job finishes any a
-- crash or a store error left behind.
CREATE TABLE media_deletions (
  media_key TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL
);

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

-- Imported places the sysop removed, at the request of the source or of the listing's owner. A re-import skips
-- every (source, external_id) listed here, so a removed listing does not come back. A row names the listing
-- only: no person, no account.
CREATE TABLE import_removals (
  source      TEXT NOT NULL,                       -- opencaching | sota | pota | …
  external_id TEXT NOT NULL,                       -- the listing's id at the source
  code        TEXT,                                -- the code the place carried here
  note        TEXT,                                -- why it was removed, as the sysop put it
  removed_at  INTEGER NOT NULL,
  PRIMARY KEY (source, external_id)
);


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
  course     INTEGER,
  -- the enrolled box that delivered the position (box_keys.box_id), from its signed request; NULL for one the
  -- shared INGEST_SECRET or any other path stored. A site trusted through a box (box_trusted_sites) attests
  -- only the positions that box delivered itself (attestedsites.ts sitesFor).
  ingest_box TEXT
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
  ack       TEXT,                                  -- the message number a sent message carried
  direction TEXT,                                  -- rx | tx
  -- how the message reached the instance, or left it: the transport positions record (provenance.ts), so the
  -- Messages list can say which network carried it. NULL on a row stored without one.
  transport TEXT,
  -- the delivery state of a sent message, NULL on received ones: when the instance heard the recipient's
  -- station acknowledge its number, the APRS-IS outbox row that carries it, and when the ingest box reported
  -- that row sent on APRS-IS
  acked_at  INTEGER,
  outbox_id INTEGER,
  sent_at   INTEGER
);
CREATE INDEX idx_messages_ts ON messages (ts);
-- the ack lookup the ingest runs for each ack it hears, and the outbox acknowledgement
CREATE INDEX idx_messages_tx_ack ON messages (ack) WHERE direction = 'tx';
CREATE INDEX idx_messages_outbox ON messages (outbox_id) WHERE outbox_id IS NOT NULL;

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

-- MeshCom as the operator's own node(s) observe it, for the map: the latest state of each node heard, and
-- the links between nodes (direct, or each leg of a relay path) with a smoothed signal report. Display
-- only — nothing here is a trust input. Rows are rewritten only when a shown value changes or at most every
-- MESHCOM_META_MIN_S seconds, and pruned nightly (MESHCOM_NODE_TTL_DAYS, MESHCOM_LINK_TTL_HOURS).
CREATE TABLE meshcom_nodes (
  callsign   TEXT PRIMARY KEY,
  last_heard INTEGER NOT NULL,
  hw_id      INTEGER,
  firmware   TEXT,
  batt       INTEGER,            -- percent
  last_via   TEXT NOT NULL,      -- direct | relayed | server | node (the receiving node's own frames)
  last_rssi  REAL,               -- of the last LoRa hearing, dBm
  last_snr   REAL,               -- dB
  quality    TEXT,               -- strong | usable | weak, from the last LoRa hearing
  receiver   TEXT,               -- the node that received it
  updated_at INTEGER NOT NULL,
  -- the relays the node named in its latest message (its --via list), for display: the sender's plan, never
  -- the route taken and never a trust input. A JSON array of callsigns, NULL when the latest message named
  -- none; msg_at is when the node's latest message was seen, NULL while none has been, so "no via list" and
  -- "not known yet" stay apart (the operator's own node's Via setting reads from its echoes).
  sent_via   TEXT,
  msg_at     INTEGER
);
CREATE INDEX idx_meshcom_nodes_heard ON meshcom_nodes(last_heard);

CREATE TABLE meshcom_links (
  from_call  TEXT NOT NULL,
  to_call    TEXT NOT NULL,
  kind       TEXT NOT NULL,      -- direct (origin -> receiver) | relay (a leg of a relay path)
  last_seen  INTEGER NOT NULL,
  samples    INTEGER NOT NULL DEFAULT 1,
  rssi_avg   REAL,               -- the leg into the receiver only: rolling average of recent samples
  snr_avg    REAL,
  receiver   TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (from_call, to_call, kind)
);
CREATE INDEX idx_meshcom_links_seen ON meshcom_links(last_seen);

-- MeshCom group chat (a message to a group number, or `*` to all), as the operator's own node(s) heard it.
-- Read-only display data, never a trust input. One row per message, however many nodes or paths delivered
-- it: dedup_key is the sender and its MeshCom msg_id (sender, group, text and a ten-minute bucket when the
-- frame carries none). A later, better hearing (direct over relayed, LoRa over the MeshCom server) replaces
-- `heard` and `receiver`. Pruned nightly with the message log (RETENTION messagesDays).
CREATE TABLE meshcom_group_messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  from_call TEXT NOT NULL,
  grp       TEXT NOT NULL,                         -- the group number, or * for all
  body      TEXT NOT NULL,
  msg_id    TEXT,                                  -- the MeshCom msg_id, hex
  receiver  TEXT,                                  -- the node that heard it
  heard     TEXT,                                  -- direct | relayed | server | node
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_meshcom_group_messages_grp ON meshcom_group_messages (grp, ts, id);
CREATE INDEX idx_meshcom_group_messages_ts ON meshcom_group_messages (ts);
CREATE INDEX idx_meshcom_group_messages_from ON meshcom_group_messages (from_call);


-- ============================================================================================
-- 6. Radio services, outbox & ingest boxes
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

-- The Mailbox: a short message held for a callsign until its station is heard, then sent to it as an APRS
-- message from the service call. Separate from the BBS, which moves its mail the F6FBB way only.
CREATE TABLE mailbox_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_call    TEXT NOT NULL,                      -- the sender's verified call, as it signs the message
  from_account TEXT NOT NULL,                      -- the account holding that call
  to_call      TEXT NOT NULL,                      -- a base call (any SSID of it) or one station's call
  body         TEXT NOT NULL,
  via          TEXT NOT NULL,                      -- app | radio
  status       TEXT NOT NULL DEFAULT 'held',       -- held | sent | delivered | undelivered | expired
  delivered_to TEXT,                               -- the station it was sent to
  msg_no       TEXT,                               -- its APRS message number on the air
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_mailbox_to ON mailbox_messages (to_call, status);
CREATE INDEX idx_mailbox_waiting ON mailbox_messages (status, expires_at);
CREATE INDEX idx_mailbox_from ON mailbox_messages (from_account, created_at);

-- The "you're near" radio message (opt-in, accounts.near_radio): when a player's own station is heard close
-- to a cache, the service call sends it a short APRS message. What was sent is kept for the limits: one
-- message per (person, cache) a day and a few per person an hour. Keyed by the base call, so switching SSIDs
-- does not reset either limit. Rows older than a day are pruned nightly.
CREATE TABLE near_cache_messages (
  call     TEXT NOT NULL,                          -- the base call of the station it went to
  cache_id INTEGER NOT NULL,
  station  TEXT NOT NULL,                          -- the station (with SSID) it went to
  msg_no   TEXT NOT NULL,                          -- its APRS message number on the air
  sent_at  INTEGER NOT NULL,
  acked_at INTEGER,                                -- when the station acknowledged it
  PRIMARY KEY (call, cache_id)
);
CREATE INDEX idx_near_cache_messages_sent ON near_cache_messages (call, sent_at);

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

-- Ingest boxes enrolled with a one-time code. Each holds its own Ed25519 key and signs every request to
-- the gateway with it, so one box is revoked without rotating the shared INGEST_SECRET of every other box.
-- An enrolled box has the ingest plane's rights and nothing more; whether what it hears counts for Tier A
-- depends only on the trusted sites (FIRST_PARTY_SITES, trusted_sites, box_trusted_sites).

-- A code the sysop creates in Instance admin, shown once. Only its SHA-256 is kept; it is good for one
-- enrollment until it expires. The row stays as the record of who let which box in.
CREATE TABLE box_enrollment_codes (
  code_hash  TEXT PRIMARY KEY,                     -- SHA-256 hex of the normalised code
  label      TEXT,                                 -- the box name the sysop gave it
  callsign   TEXT,                                 -- optional base call the box may name as its receiving site
  created_by TEXT NOT NULL,                        -- the sysop's account id, or 'operator' (OPERATOR_SECRET)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  box_id     TEXT                                  -- the box it enrolled
);

-- An enrolled box's public key, with who enrolled and who revoked it. A revoked key never verifies again;
-- the box enrolls anew with a fresh code and key.
CREATE TABLE box_keys (
  box_id       TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL UNIQUE,               -- raw Ed25519, base64url
  label        TEXT,
  callsign     TEXT,
  enrolled_by  TEXT NOT NULL,
  enrolled_at  INTEGER NOT NULL,
  revoked_by   TEXT,
  revoked_at   INTEGER,
  last_seen_at INTEGER,                            -- refreshed at most every five minutes
  -- "Runs this instance's services": the sysop lets the box serve the packet BBS mailbox, FBB forwarding,
  -- the NET/ROM node mirror, White Pages, federation frames, the APRS-IS outbox and box TX commands. Off by
  -- default, and independent of trusting its hearings: a lent receiver never runs them.
  services     INTEGER NOT NULL DEFAULT 0
);

-- Receiving sites the sysop trusts from Instance admin. A trusted site counts for Tier A beside the sites in
-- FIRST_PARTY_SITES (the configuration's preset list): only a frame that site's own receiver heard directly,
-- delivered by an ingest box, is attested. Default-deny: no row, no trust.

-- A station the sysop adds by its site call, such as their own box on the shared INGEST_SECRET.
CREATE TABLE trusted_sites (
  site       TEXT PRIMARY KEY,                     -- the receiving site call, upper-case, with SSID
  trusted_by TEXT NOT NULL,                        -- the sysop's account id, or 'operator' (OPERATOR_SECRET)
  trusted_at INTEGER NOT NULL
);

-- "Trust this station's hearings" on an enrolled box: a ham lends their own receiver to this instance. The
-- sites count for as long as the box stays enrolled, and a box enrolled for a callsign is trusted only for
-- sites of that base call. Turning trust off or revoking the box deletes its rows.
CREATE TABLE box_trusted_sites (
  box_id     TEXT NOT NULL,                        -- the enrolled box (box_keys.box_id)
  site       TEXT NOT NULL,                        -- the receiving site call it attests, upper-case, with SSID
  trusted_by TEXT NOT NULL,
  trusted_at INTEGER NOT NULL,
  PRIMARY KEY (box_id, site)
);


-- ============================================================================================
-- 7. BBS & packet node
-- ============================================================================================

-- The store-and-forward message base. The BBS moves mail the F6FBB way only: it never delivers over APRS
-- (the Mailbox does that). Bulletins are deduped by BID across forwarding. The format (P/B/T type,
-- BID/MID) is MBL/FBB-compatible, so a connected-mode gateway can bridge. Replies chain into threads:
-- `thread_id` is the root message's id.
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

-- White pages: a callsign's home BBS, steering personal mail. `manual` is set by the operator and steers
-- mail until the operator changes it; `learned` comes from the R: header of forwarded mail and never
-- replaces a manual entry.
CREATE TABLE white_pages (
  callsign   TEXT PRIMARY KEY,
  home_bbs   TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'learned'))
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
  updated_at      INTEGER NOT NULL DEFAULT 0,
  -- federation over FBB (FED_BBS) travels only to and from the partners the sysop marks for it, once the
  -- partner's sysop has agreed to carry machine data; off unless turned on
  federation      INTEGER NOT NULL DEFAULT 0
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
  -- per-peer pull cursors of the keys and bulletins feeds; bulletins page by (timestamp, id) because a
  -- timestamp repeats. Caches, finds, tombstones and account moves sync per origin (fed_origin_marks).
  keys_cursor         INTEGER NOT NULL DEFAULT 0,
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
  rep_failed          INTEGER NOT NULL DEFAULT 0,  -- corroborations contradicted
  -- the base callsign ARDC verified for a peer added over 44net (its <call>.ampr.org zone carries the
  -- binding). The corroboration quorum counts peers by operator: the registry's operator when it names one,
  -- else this call, else the signing key, so several instances of one callsign are one voice.
  operator_call       TEXT,
  -- the key fingerprint the sysop pinned for a FED_PEERS entry (`<url>#<fingerprint>`): SHA-256 of the raw
  -- Ed25519 key, its first 16 hex digits in four groups of four. A sync refuses a peer whose keys do not match
  -- it, and a peer whose key matches starts trusted; an entry without one starts unvetted until the sysop
  -- compares fingerprints.
  pinned_fingerprint  TEXT,
  -- where the endpoint set came from: 'dns' (its 44Net callsign binding, set when it is added by callsign),
  -- 'descriptor' (the `addresses` its own descriptor lists, read on each sync) or 'announce' (a verified
  -- presence beacon). A sync replaces only a set it learned itself, never one DNS set.
  endpoints_source    TEXT,
  -- the key a FED_PEERS fingerprint pin matched. The pin then holds for every key reached from it along the
  -- peer's verified rotation chain, so a rotation past its grace period keeps the peer.
  pin_matched_key     TEXT,
  -- when corroboration raised an unvetted peer to trusted on its own. `added_via` keeps how the peer arrived;
  -- an operator's trust decision clears this.
  auto_promoted_at    INTEGER,
  -- the peer's rotation records (JSON), kept so a hub can hand them on with the peer's key: an instance that
  -- learns the peer through the hub follows its key along the same verified chain
  rotations           TEXT,
  -- how this instance heard of a peer it never added itself (feddiscover.ts): a trusted peer's list of the
  -- instances it trusts (peer exchange), or an mDNS announcement on the local network. `discovered` holds the
  -- sightings as JSON [{via, fp, at}]: `via` is the listing peer's instance id or `mdns`, `fp` the key
  -- fingerprint that source gave, `at` when it last said so. `listed_at` is the newest sighting; a row that
  -- only discovery brought and that no source lists any more expires. A sighting never sets a peer's key: a
  -- fingerprint that differs from the pinned key's is shown to the sysop, and the pin stays.
  discovered          TEXT,
  listed_at           INTEGER
);
-- An instance id names one live peer: a second non-blocked row claiming it is an impostor or a stale
-- address, and the operator decides which by blocking or deleting it. A block covers the instance, not one
-- address.
CREATE UNIQUE INDEX fed_peers_instance_live ON fed_peers (instance) WHERE trust != 'blocked';
CREATE INDEX idx_fed_peers_listed ON fed_peers (listed_at) WHERE listed_at IS NOT NULL;

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
  mirrored_at  INTEGER NOT NULL,
  -- the origin's federation scope, so an `unlisted` cache stays off this instance's map and offline packs
  -- as it does on its origin
  fed_scope    TEXT NOT NULL DEFAULT 'public'
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
  global_id   TEXT PRIMARY KEY,                    -- origin:key:fed_seq
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
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT NOT NULL UNIQUE,                  -- uuid
  kind      TEXT NOT NULL,                         -- account | find | cache | …
  target_id TEXT NOT NULL,                         -- the removed record's global id (never a callsign)
  origin    TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  -- the cache version a moderation removal covers (NULL: every version, as for an erasure). A cache the
  -- sysop restores comes back at a higher version, which the tombstone no longer suppresses.
  up_to     INTEGER,
  fed_seq   INTEGER NOT NULL DEFAULT 0             -- the feed cursor and signed version (trigger below)
);
CREATE INDEX idx_tombstones_ts ON tombstones (ts);
CREATE INDEX idx_tombstones_fed_seq ON tombstones (fed_seq);

CREATE TABLE remote_tombstones (
  target_id   TEXT PRIMARY KEY,
  origin      TEXT NOT NULL,                       -- the instance that emitted it
  kind        TEXT NOT NULL,
  ts          INTEGER NOT NULL,                    -- emit time carried from the tombstone
  mirrored_at INTEGER NOT NULL,
  up_to       INTEGER                              -- as tombstones.up_to
);

-- Account moves. The target instance publishes a signed move record carrying the mover's proof: the
-- device-key assertion signed on import and bound to the target. A mirror keeps a move only when that
-- proof verifies under a key it knows for the callsign independently of the claimant, and orders moves
-- by the proof's signing time, so an old proof re-announced later never takes an account back.
CREATE TABLE account_moves (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  callsign      TEXT NOT NULL,
  from_instance TEXT,
  to_instance   TEXT NOT NULL,                     -- this instance, at publish time
  ts            INTEGER NOT NULL,
  proof_key     TEXT,
  proof_sig     TEXT,
  proof_at      INTEGER,
  fed_seq       INTEGER NOT NULL DEFAULT 0         -- the feed cursor and signed version (trigger below)
);
CREATE INDEX idx_account_moves_call ON account_moves (callsign);
CREATE INDEX idx_account_moves_fed_seq ON account_moves (fed_seq);

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

-- Record numbering. An instance tracks what it holds of every origin, per record kind, instead of how far
-- it read each neighbour: "every cache of origin Y up to sequence N is here". Any neighbour can then fill
-- the gap after N, and switching paths never reads again what is already held (fedtransit.ts).
--
-- Each record kind counts up per origin, and that count is the record's signed version `v`: a cache's
-- fed_rev and the fed_seq of a find, a tombstone and an account move. Every insert (and every update of a
-- cache) takes the next number of its kind's counter, at least the current time in milliseconds: a database
-- restored from an older backup carries an older counter, and the time floor still puts its new records
-- above every number it handed out before. A row inserted with its number (a backup restored, with the
-- counter beside it) keeps it. The number is also the record's global id (`<instance>:cache:<fed_id>`,
-- `…:find:<fed_seq>`, …): row ids come back with a backup and are handed out again, sequence numbers are
-- not, so a new record never takes the global id of one the peers hold or deleted.
CREATE TABLE fed_seq (
  kind TEXT PRIMARY KEY,                           -- cache | find | tombstone | account-move | key
  n    INTEGER NOT NULL
);
INSERT INTO fed_seq (kind, n) VALUES ('cache', 0), ('find', 0), ('tombstone', 0), ('account-move', 0), ('key', 0);

CREATE TRIGGER caches_fed_rev_insert AFTER INSERT ON caches
WHEN NEW.fed_rev = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'cache';
  UPDATE caches SET fed_rev = (SELECT n FROM fed_seq WHERE kind = 'cache'),
                    fed_id = CASE WHEN NEW.fed_id = 0 THEN (SELECT n FROM fed_seq WHERE kind = 'cache') ELSE NEW.fed_id END
   WHERE id = NEW.id;
END;
CREATE TRIGGER caches_fed_rev AFTER UPDATE ON caches
WHEN NEW.fed_rev = OLD.fed_rev
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'cache';
  UPDATE caches SET fed_rev = (SELECT n FROM fed_seq WHERE kind = 'cache') WHERE id = NEW.id;
END;
CREATE TRIGGER cache_logs_fed_seq AFTER INSERT ON cache_logs
WHEN NEW.fed_seq = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'find';
  UPDATE cache_logs SET fed_seq = (SELECT n FROM fed_seq WHERE kind = 'find') WHERE id = NEW.id;
END;
-- A count per cache that every rewrite or removal of one of its logs raises: an anonymisation, a moderation removal,
-- an edit or a later corroboration. The offline pack's generation reads it, since a rewrite in place changes neither
-- the number of logs nor the highest id.
CREATE TABLE cache_log_revs (
  cache_id INTEGER PRIMARY KEY,
  rev      INTEGER NOT NULL
);
CREATE TRIGGER cache_logs_rev_update AFTER UPDATE ON cache_logs
BEGIN
  INSERT INTO cache_log_revs (cache_id, rev) VALUES (NEW.cache_id, 1)
    ON CONFLICT(cache_id) DO UPDATE SET rev = rev + 1;
  INSERT INTO cache_log_revs (cache_id, rev) SELECT OLD.cache_id, 1 WHERE OLD.cache_id != NEW.cache_id
    ON CONFLICT(cache_id) DO UPDATE SET rev = rev + 1;
END;
CREATE TRIGGER cache_logs_rev_delete AFTER DELETE ON cache_logs
BEGIN
  INSERT INTO cache_log_revs (cache_id, rev) VALUES (OLD.cache_id, 1)
    ON CONFLICT(cache_id) DO UPDATE SET rev = rev + 1;
END;
CREATE TRIGGER tombstones_fed_seq AFTER INSERT ON tombstones
WHEN NEW.fed_seq = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'tombstone';
  UPDATE tombstones SET fed_seq = (SELECT n FROM fed_seq WHERE kind = 'tombstone') WHERE seq = NEW.seq;
END;
CREATE TRIGGER account_moves_fed_seq AFTER INSERT ON account_moves
WHEN NEW.fed_seq = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'account-move';
  UPDATE account_moves SET fed_seq = (SELECT n FROM fed_seq WHERE kind = 'account-move') WHERE seq = NEW.seq;
END;
CREATE TRIGGER callsign_keys_fed_seq AFTER INSERT ON callsign_keys
WHEN NEW.fed_seq = 0
BEGIN
  UPDATE fed_seq SET n = MAX(n + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE kind = 'key';
  UPDATE callsign_keys SET fed_seq = (SELECT n FROM fed_seq WHERE kind = 'key') WHERE id = NEW.id;
END;

-- What this instance holds of each origin: for one record kind (cache | find | tombstone | account-move), every
-- record up to `seq` is here, or was superseded or deleted. `region` is the FED_SYNC_REGION a caches mark was read
-- under; '' holds the whole feed and stands for any region.
CREATE TABLE fed_origin_marks (
  origin     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  region     TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (origin, kind)
);
-- How far this instance has read one neighbour's pages of one origin and kind, held or not: it asks that
-- neighbour again only past this, unless the neighbour holds the origin whole beyond this instance's mark.
CREATE TABLE fed_read_positions (
  via      TEXT NOT NULL,
  origin   TEXT NOT NULL,
  kind     TEXT NOT NULL,
  region   TEXT NOT NULL DEFAULT '',
  seq      INTEGER NOT NULL,
  -- the neighbour's `held` this instance last read its pages again from the mark for, so it does that once per
  -- value of `held`, never at every pass
  replayed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (via, origin, kind, region)
);
-- Records of an origin this instance knows it does not hold whole, though its mark has moved past them: one that
-- did not settle (a frame signed ahead of this clock, one the database could not take, one that did not verify),
-- one kept past the hop limit, or one a neighbour said it lacks. Each is asked for again on its own, from every
-- neighbour, backing off per neighbour (`tries`, JSON {via: [attempts, next unix second]}).
CREATE TABLE fed_origin_gaps (
  origin     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  reason     TEXT NOT NULL,                      -- unsettled | upstream | hops | upstream-hops
  first_seen INTEGER NOT NULL,
  tries      TEXT NOT NULL DEFAULT '{}',
  attempts   INTEGER NOT NULL DEFAULT 0,         -- failed asks, from every neighbour together
  PRIMARY KEY (origin, kind, v)
);
-- Gaps no neighbour filled within 7 days and 5 asks: given up, so the marks move past them, and listed for the
-- sysop until marked seen; a row seen 30 days ago goes, and one never seen goes after 90 days. A missing tombstone is
-- never given up. A record past the hop limit (`hops`, `upstream-hops`) is no fault anyone can fix but by a shorter
-- path: its gap goes silently after 30 days.
CREATE TABLE fed_gaps_given_up (
  origin     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  given_up   INTEGER NOT NULL,
  seen_at    INTEGER,
  PRIMARY KEY (origin, kind, v)
);
-- Counts up whenever what this instance held of an origin is forgotten (its records dropped with a key a
-- neighbour handed on), so a pull already under way for the origin moves no mark afterwards.
CREATE TABLE fed_mark_gen (
  origin TEXT PRIMARY KEY,
  gen    INTEGER NOT NULL
);

-- Records a hub passes on. Every cache, find, tombstone and account move mirrored from another instance keeps
-- the frame its origin signed, byte for byte, so this instance can serve it again (fedtransit.ts) without
-- re-signing it: a receiver verifies it against the origin's key and applies the origin's trust. The frames
-- are served per origin, in the origin's own order.
CREATE TABLE fed_transit (
  gid         TEXT PRIMARY KEY,                    -- the record's global id, in its origin's namespace
  origin      TEXT NOT NULL,                       -- the instance that signed it
  kind        TEXT NOT NULL,                       -- the sync type: cache | find | tombstone | account-move
  v           INTEGER NOT NULL,                    -- the version held, the one the frame carries
  frame       BLOB NOT NULL,                       -- the signed fedwire frame, verbatim
  signer_key  TEXT NOT NULL,                       -- the origin key the frame verified under
  via         TEXT NOT NULL,                       -- the instance that delivered it here (the origin itself when direct)
  hops        INTEGER NOT NULL,                    -- instances crossed to reach here: 1 straight from the origin
  target      TEXT,                                -- a tombstone's target global id
  scope       TEXT,                                -- a cache's fed_scope
  lat         REAL,                                -- a cache's position, for a region-filtered pull
  lon         REAL,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_fed_transit_origin ON fed_transit (origin, kind, v);

-- Push-to-hub state that survives a restart.
--
-- On a spoke: how far each feed has been pushed to the hub (advanced only after the hub's 2xx, so a
-- restart resumes instead of pushing everything again), and how the last push went, for the operator's
-- view and for the reconnect probe.
CREATE TABLE fed_push_cursors (
  hub        TEXT NOT NULL,
  type       TEXT NOT NULL,                 -- the feed: tombstone | cache | find | key
  cursor     INTEGER NOT NULL,
  cursor_id  INTEGER,                       -- the id tie-breaker of a composite feed, mid-pass
  updated_at INTEGER NOT NULL,
  rewound_to INTEGER,                       -- the push went back once to where its hub held it whole: not again to the same place
  PRIMARY KEY (hub, type)
);
CREATE TABLE fed_hub_status (
  hub             TEXT PRIMARY KEY,
  last_attempt_at INTEGER,
  last_ok_at      INTEGER,                  -- the last push cycle that completed
  last_error      TEXT,
  offline_since   INTEGER                   -- the first network failure of the current outage
);

-- On a hub: per spoke and feed, the spoke's cursor after the last page the hub admitted. The hub returns
-- it, so a spoke restored from a backup resumes where the hub is, and a hub restored from a backup gets
-- back what it lost. Display-only beyond that: it changes no trust.
CREATE TABLE fed_submit_marks (
  instance     TEXT NOT NULL,
  type         TEXT NOT NULL,
  cursor       INTEGER NOT NULL,
  cursor_id    INTEGER,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (instance, type)
);

-- Federation pull over packet circuits: the ingest box dials a peer's ax25 or netrom endpoint, hands each page
-- to /federation/frames and reports the session here, one row per peer instance. The cursors belong to this
-- path alone, so the packet pull and the HTTP pull never move each other's position; a record that arrives
-- both ways applies once, by its version.
CREATE TABLE fed_packet_sync (
  instance     TEXT PRIMARY KEY,
  transport    TEXT,                        -- ax25 | netrom, the endpoint of the last session
  address      TEXT,
  last_attempt INTEGER,
  last_ok      INTEGER,
  last_error   TEXT,
  sessions_ok  INTEGER NOT NULL DEFAULT 0,
  sessions_err INTEGER NOT NULL DEFAULT 0,
  last_counts  TEXT,                        -- JSON {pages, frames, applied, quarantined, rejected, complete}
  cursors      TEXT                         -- JSON {feed: {since, sinceId?}}
);


-- ============================================================================================
-- 9. Moderation
-- ============================================================================================
-- What players report, what the sysop does about it, and which accounts are suspended. None of it
-- federates: a removal that peers must follow travels as a signed tombstone (tombstones.ts), never as one
-- of these rows.

-- A report a player (or a signed-out visitor) files against a cache, a log, a media item, a message or a
-- profile. Only the sysop reads reports; the reported person never learns who filed one.
CREATE TABLE moderation_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind      TEXT NOT NULL,                  -- cache | log | media | message | bbs | mailbox | meshcom | profile
  target_id        TEXT NOT NULL,                  -- the row id, or the base call of a profile
  target_label     TEXT,                           -- what the target was when reported (a code, a call)
  target_account   TEXT,                           -- the account the content belongs to, when one does
  category         TEXT NOT NULL,                  -- spam | offensive | unsafe | copyright | other
  text             TEXT,                           -- the reporter's own words, length-capped
  reporter_account TEXT,                           -- NULL for a signed-out report, and after the reporter's erasure
  reporter_call    TEXT,
  status           TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  resolution       TEXT,                           -- the sysop's note on how it was settled
  resolved_by      TEXT,
  resolved_at      INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_moderation_reports_status ON moderation_reports (status, created_at);
CREATE INDEX idx_moderation_reports_target ON moderation_reports (target_kind, target_id);
CREATE INDEX idx_moderation_reports_reporter ON moderation_reports (reporter_account);

-- The audit log: one row per moderation action, kept as the instance's legitimate-interest record. The
-- person an action concerns finds the rows about their account in their data export.
CREATE TABLE moderation_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  actor_call     TEXT NOT NULL,                    -- the sysop's call, or OPERATOR for a scripted action
  action         TEXT NOT NULL,                    -- remove | restore | suspend | unsuspend | resolve | reopen
  target_kind    TEXT NOT NULL,                    -- as moderation_reports, plus account and report
  target_id      TEXT NOT NULL,
  target_label   TEXT,
  target_account TEXT,
  reason         TEXT
);
CREATE INDEX idx_moderation_log_at ON moderation_log (at);
CREATE INDEX idx_moderation_log_account ON moderation_log (target_account);

-- A suspended account: no sign-in, no write and no transmission through this instance while it holds.
-- `until` NULL holds until the sysop lifts it. The person's public content stays unless removed on its own.
CREATE TABLE account_suspensions (
  account_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  until      INTEGER,
  by_call    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  -- the category the suspension is filed under: the one thing about it that outlives an erasure
  category   TEXT NOT NULL DEFAULT 'other'
);

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


-- ============================================================================================
-- 10. Shack tools
-- ============================================================================================

-- Tool registries the Tools app lists (toolregistries.ts). A row with no account_id is the instance's, managed by
-- the sysop; one with an account_id is that player's own. `authority` is the key the person pinned after
-- comparing its fingerprint: the browser verifies every registry file against it and never takes a key from the
-- file. The project registry bundled with the app is the row `builtin` while the sysop has it switched off; it
-- has no row while it is on. TOOL_REGISTRIES in the environment replaces the instance rows.
CREATE TABLE tool_registries (
  id           TEXT PRIMARY KEY,
  account_id   TEXT,
  spec         TEXT NOT NULL,                 -- the address as entered: https URL or github:owner/repo[/path][@ref]
  url          TEXT NOT NULL,                 -- the address fetched
  authority    TEXT NOT NULL,                 -- pinned Ed25519 public key, base64url
  label        TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,              -- when the key was last confirmed
  added_by     TEXT NOT NULL                  -- the call that added it, or OPERATOR for a scripted change
);
CREATE INDEX idx_tool_registries_account ON tool_registries (account_id);

-- The copies the gateway keeps of a registry's files when it fetches them for browsers: the registry file, the
-- manifests its entries name and the scripts those name. `body` is the last good copy, served while a refetch
-- fails; `tried_at` spaces out the attempts. The browser checks every signature; this is only a carrier.
CREATE TABLE tool_registry_files (
  registry_id  TEXT NOT NULL,
  url          TEXT NOT NULL,
  body         TEXT,
  content_type TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  fetched_at   INTEGER,                       -- when the last good copy arrived
  tried_at     INTEGER NOT NULL,              -- the last attempt, good or not
  error        TEXT,                          -- why the last attempt failed
  PRIMARY KEY (registry_id, url)
);


-- ============================================================================================
-- 11. Operations
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
-- here: one row per key, rolled over in place, expired windows pruned nightly. reset_at is unix
-- milliseconds.
CREATE TABLE rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

-- The newest published release, as the daily update check last read it from the project's releases
-- (updatecheck.ts). One row: the release tag and its page, the ETag that keeps the next request a cheap 304,
-- and when the check last got an answer. Whether an update is available is worked out on read against the
-- running version, so a restart onto the new release clears it at once.
CREATE TABLE update_check (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  tag        TEXT,
  url        TEXT,
  etag       TEXT,
  checked_at INTEGER NOT NULL
);

-- Site settings: the policy values the sysop sets in Instance admin → Instance settings (sitesettings.ts). A row
-- holds the value as it is stored, already checked against the configuration schema; a key the environment sets
-- wins over its row, and a key with no row takes the schema default. Resetting a setting deletes its row. The
-- change history is the moderation audit log.
CREATE TABLE site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL                          -- the sysop's call, or OPERATOR for a scripted change
);
