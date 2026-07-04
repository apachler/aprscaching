# HTTP API

The gateway exposes one HTTP surface across all runtimes. Every response is CORS-wrapped; `OPTIONS` on any
path returns `204`. The stable, versioned, rate-limited read surface is `/api/v1` (see
[the read API](#public-read-api)); the other routes power the web app and federation.

## Authentication

| Gate | Meaning |
|------|---------|
| **public** | No authentication. |
| **rate-limited** | Public, throttled per IP (and higher with a free API key). |
| **session** | A passkey or email-verified cookie session. |
| **actor** | A session **or** `x-ingest-secret` — the "web write behind sign-in / RF write over APRS" dual path. |
| **x-ingest-secret** | Matches `INGEST_SECRET` — a trusted operator backend (the ingest box). |
| **sysop** | A signed-in operator whose callsign is in `ADMIN_CALLSIGNS` (or `x-ingest-secret`). Locked if `ADMIN_CALLSIGNS` is unset. |
| **signed-body** | An Ed25519 assertion (`key`, `sig`, `at`) registered to the callsign, or a matching session. |
| **x-relay-secret / x-fed-secret / wx-key** | Federation relay / federation submit-corroborate / weather-station keys. |

## Public read API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1`, `/api/v1/*` | Versioned free read API — caches, finds, stations, leaderboard, exports (GPX/KML/ADIF). Rate-limited; higher limits with a free key. |
| POST | `/api/v1` (key path) | Issue a free API key. |

## Caching & finds

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/caches?bbox=` | Caches in a box (native + trust-filtered federated mirrors) | public |
| POST | `/api/caches` | Hide a cache | actor |
| GET · PATCH | `/api/caches/:id` | Detail · update (owner) | public · actor |
| GET · POST | `/api/caches/:id/logs` | Logbook · log a find/DNF/note | public · actor |
| POST | `/api/caches/:id/favorite` · `/watch` · `/rate` | Favorite · watch · rate 1–5 (finders) | public/session |
| GET | `/api/search?q=` · `/api/leaderboard` · `/api/activity` | Search · rankings · activity feed | public |
| GET | `/api/corroborators` · `/api/profile/:call` | Top corroborating IGates · public profile | public |
| GET · POST | `/api/caches/:id/media`, `/stages`, `/stages/:n/unlock` | Media gallery & audio-cache staged unlock | public/actor |

## Stations & workbench

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/stations`, `/api/stations/:call`, `/:call/series`, `/:call/packets` | Live registry, detail, telemetry series, raw packets | public |
| POST | `/api/decode` | Decode a raw TNC2 line | public |
| GET | `/api/ports` · `/api/messages` | Transport status · APRS message log | public |
| POST | `/api/tx/aprs` | Gated user APRS TX | session (verified callsign) |
| GET/POST | `/api/my/stations`, `/:sid`, `/:sid/wx-key`, `/:sid/cache` | Manage your own stations; issue a weather key; make one a cache | session |
| GET/POST | `/api/wx/submit`, `/updateweatherstation` | PWS push (Ecowitt / WU-Rapidfire) | wx-key |
| GET/POST | `/api/wx/key`, `/api/wx/tx` | Your `-13` weather-station key; toggle WX beacon (TX) | session |

## Live

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/ws?region=` | Upgrade to a region "room" (live positions/finds) |
| GET | `/api/spots` | Live activity spots (POTA/SOTA/DX…), off unless `SPOTS_ENABLED` |
| GET | `/api/cot` | Cursor-on-Target snapshot for TAK (`bbox`) |
| GET | `/api/cot/stream` | Cursor-on-Target push feed (Server-Sent Events): snapshot, then live updates |

## Federation

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/.well-known/aprscaching` | Instance discovery document | public |
| GET | `/federation/caches`, `/finds`, `/bulletins`, `/keys`, `/tombstones`, `/account-moves`, `/registry` | Signed, cursor-paged feeds | public |
| GET · POST | `/federation/peers` · `/peers/trust` | Peer list + health · set trust | sysop |
| POST | `/federation/sync` | Pull from all peers | x-ingest-secret |
| POST | `/federation/corroborate` | Cross-instance corroboration query | public (rate-limited; `x-fed-secret` if configured) |
| POST | `/federation/notify` | Gossip "come pull" ping | public |
| POST | `/federation/submit` | Hub accepts a spoke's signed records | x-fed-secret (`FED_SUBMIT_SECRET`) |
| POST · GET | `/federation/relay/:instance/query`, `/lease`, `/answer`, `/result/:id` | The poll-based rendezvous relay | x-relay-secret |

## Remote box

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/api/box/:id/command` | Enqueue a command (TX kinds need a verified callsign) | session or x-ingest-secret |
| GET · POST | `/api/box/:id/commands` · `/commands/ack` | Box leases · acks commands | x-ingest-secret |
| GET | `/api/box/:id/log` | Operator view of command activity | actor |

## Admin / sysop

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/whoami` | Whether the caller is an operator |
| GET/POST | `/api/node/nodes` · GET `/api/node/mheard` | NET/ROM NODES table · MHeard |
| GET/POST/DELETE | `/api/bbs/forward`, `/forward/:id`, `/partners`, `/partners/:id` | FBB forwarding rules + partners |

All admin writes are **sysop**-gated server-side.

## Ingest & BBS backend

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ingest` | Ingest positions/finds/packets (`x-ingest-secret` or on-device signed) |
| GET · POST | `/outbox` · `/outbox/ack` | Box pulls / acks queued APRS-IS messages |
| GET/POST | `/api/bbs/forward/pool`, `/inbound`, `/sent`, `/session`, `/kill` | Forwarding + connected-mode BBS session backend (x-ingest-secret) |
| POST | `/api/import/:source` | Import an external catalog | 

## Accounts, identity & GDPR

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/auth/passkey/*`, `/auth/email/*`, `/auth/claim`, `/auth/logout` | Passkey + email sign-in, claim, sign-out | public → session |
| GET/POST | `/auth/session`, `/auth/callsign(s)`, `/auth/profile` | Session + base-callsign management | session |
| POST/GET | `/verify/aprs/start`, `/confirm`, `/status` | Callsign control-verification (APRS challenge) | session |
| POST · GET | `/keys/register` · `/keys/:call` | Register a device key · list a callsign's keys | session · public |
| POST | `/api/account/:call/export`, `/delete`, `/bundle`, `/move`, `/api/account/import` | GDPR export/erase + account portability | signed-body |
| GET/PUT | `/api/prefs`, `/api/watch*`, `/api/notify/prefs`, `/api/push/*`, `/api/views`, `/v/:id` | Preferences, watchlist + alerts, push, saved map views | session |

## BBS (public)

| Method | Path | Purpose |
|--------|------|---------|
| POST · GET | `/api/bbs/messages`, `?to=`, `/sent?from=`, `/bulletins`, `/thread/:id` | Store-and-forward mail + bulletins |
| GET | `/api/bbs/route` · `/api/bbs/wp` | Hierarchical routing lookup · White Pages directory |

## Misc

`GET /health` · `/source` + `/.well-known/source` (running source) · `/support` + `/api/support` ·
`/sitemap.xml` + `/sitemap` + `/robots.txt` · `/feeds/*.xml` (RSS: activity, caches, bulletins, leaderboard,
per-user) · `/badge/:call.svg` (embeddable network badge) · `/embed` + `/embed/qr.svg` (embeddable map + QR).

## Scheduled tasks

On a cron the gateway prunes TTL'd firehose positions, the raw-packet ring, tombstones and stale relay
queue entries; then pulls federation (`syncAllPeers`), runs push-to-hub and the relay spoke leg (both no-ops
unless configured), and sends watch-alert email digests.
