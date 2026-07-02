-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0004 depth  —  consolidated initial schema (part 4 of 4)
-- Depth — bulletin federation, position telemetry, the raw-packet workbench ring, cache
-- metadata / ratings / NFC unlock / media, living-cache rendezvous, threaded BBS + hierarchical
-- forwarding + partners + forward log, the NET/ROM node, account preferences, and the federation relay queue.
-- Squashed baseline: greenfield deploys create the whole schema from these four files.

-- ─── bbs federation ───
-- Bulletin federation (BBS #1): peers exchange bulletins over the signed feed mechanism, deduped by
-- BID. A per-peer cursor makes the bulletin pull incremental, like the cache/find/key feeds.
ALTER TABLE fed_peers ADD COLUMN bulletins_cursor INTEGER NOT NULL DEFAULT 0;

-- ─── position telemetry ───
-- Telemetry history: the station table keeps only the *latest* speed/altitude/
-- course, so a track had no motion history to graph. Carry the per-fix telemetry onto positions too,
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
-- guests keep the same settings in localStorage only. Keyed by account_id (person), per ADR-1/ADR-2:
-- prefs belong to the person, not a bare callsign. All three runtimes. Inside the GDPR export/erase.
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
