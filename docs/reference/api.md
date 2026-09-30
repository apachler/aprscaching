# HTTP API

The gateway exposes one HTTP surface across all runtimes. Every response is CORS-wrapped; `OPTIONS` on any
path returns `204`. The stable, versioned, rate-limited read surface is `/api/v1` (see
[the read API](#public-read-api)); the other routes power the web app and federation.

## Authentication

| Gate | Meaning |
|------|---------|
| **public** | No authentication. |
| **rate-limited** | Public, throttled per IP (and higher with a free API key). |
| **session** | A passkey, email-link or operator-link cookie session, signed with `SESSION_SECRET`. It names the account and its session generation, and resolves only while that account exists at that generation and holds the session's call. |
| **actor** | A session **or** `x-ingest-secret` — the "web write behind sign-in / RF write over APRS" dual path. |
| **x-ingest-secret** | Matches `INGEST_SECRET` — the ingest box. Ingest-plane only: never operator configuration, device keys or sessions. |
| **x-operator-secret** | Matches `OPERATOR_SECRET` — the operator's scripts. Closed while `OPERATOR_SECRET` is unset. |
| **sysop** | A signed-in operator whose callsign is in `ADMIN_CALLSIGNS`, held by their account and control-verified, or `x-operator-secret` where marked. Locked if `ADMIN_CALLSIGNS` is unset. |
| **signed-body** | An Ed25519 assertion (`key`, `sig`, `at`) registered to the callsign, or a session of the account that holds the call. |
| **x-relay-secret / x-fed-secret / wx-key** | Federation relay / federation submit-corroborate / weather-station keys. |

Cross-origin requests carry credentials only from `APP_URL` and `CORS_ORIGINS`; with neither set the
gateway answers `Access-Control-Allow-Origin: *` without credentials.

## Public read API

```bash
curl -s https://aprs.example.net/api/v1                                          # index: routes, limits, how to get a key
curl -s "https://aprs.example.net/api/v1/caches?bbox=15.3,47.0,15.5,47.1"        # bbox = minLon,minLat,maxLon,maxLat
KEY=$(curl -s -X POST https://aprs.example.net/api/v1/keys | jq -r .key)         # free key, no sign-up
curl -s -H "Authorization: Bearer $KEY" "https://aprs.example.net/api/v1/stations?bbox=15.3,47.0,15.5,47.1"
curl -s "https://aprs.example.net/api/v1/activity?key=$KEY"                       # or pass the key as ?key=
```

Limits per 60-second window: 60 requests per IP without a key, 600 with one (`API_RATE_*`); a box may span at
most 20° a side.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1` | Self-describing index of the read API. |
| GET | `/api/v1/caches` · `/caches/:code` · `/caches.gpx` · `/caches.kml` · `/caches/:code.gpx` | Caches in a box (`bbox`), one cache, and GPX/KML exports. |
| GET | `/api/v1/stations` · `/station/:call` · `/station/:call/track` · `/station/:call.kml` | Live stations, one station, its track (JSON/KML). |
| GET | `/api/v1/profile/:call` · `/profile/:call.adif` | A callsign's public profile · its finds as ADIF 3.1 (`SIG=APRSCACHING`). |
| GET | `/api/v1/activity` · `/leaderboard` · `/corroborators` · `/spots` | Activity feed, rankings, top corroborating IGates, live spots. |
| GET | `/api/v1/licence/:call` | Callsign validity from public licence registers (same as `/api/licence/:call`). |
| POST · GET | `/api/v1/keys` · `/api/v1/keys/:id` | Issue a free API key · look one up. |

Every `/api/v1` route is rate-limited per IP; a free key raises the limit. Keys never gate a feature.

## Caching & finds

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/caches?bbox=` | Caches in a box (native + trust-filtered federated mirrors) | public |
| POST | `/api/caches` | Hide a cache | actor |
| GET · PATCH | `/api/caches/:id` | Detail · update (owner) | public · actor |
| GET · POST | `/api/caches/:id/logs` | Logbook · log a find/DNF/note | public · actor |
| GET | `/api/radio/commands` | Your radio commands (FOUND / DNF / NOTE / HELP messages) and the service call to send them to | session |
| POST | `/api/radio/commands/:id/confirm` · `/discard` | Log or drop a command that arrived only over the internet | session |
| POST | `/api/caches/:id/favorite` · `/watch` · `/rate` | Favorite · watch · rate 1–5 (finders) | public/session |
| GET | `/api/search?q=` · `/api/leaderboard` · `/api/activity` | Search · rankings · activity feed | public |
| GET | `/api/corroborators` · `/api/profile/:call` | Top corroborating IGates · public profile | public |
| GET · POST | `/api/caches/:id/media`, `/stages`, `/stages/:n/unlock` | Media gallery; stages (owner sets them with POST `/stages`) & staged unlock | public/actor |
| DELETE · PUT | `/api/caches/:id/media/:mid` · `/api/caches/:id/stages/:n/media` | Remove a photo · set a stage's audio clue | actor (owner) |
| GET | `/api/media/*` | Serve an uploaded photo or audio file | public |
| GET | `/api/adoptions` | Caches up for adoption, with the sysop's public note and when the owner's notice ends | public |
| GET · POST · DELETE | `/api/caches/:id/adoption` | The offer on a cache and your own request · request adoption (`{ inPlace, note? }`, needs a control-verified call) · the owner keeps the cache | public · session |
| DELETE | `/api/caches/:id/adoption/request` | Withdraw your pending adoption request | session |

## Stations & the Shack

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/stations`, `/api/stations/:call`, `/:call/series`, `/:call/packets` | Live registry, detail, telemetry series, raw packets | public |
| GET | `/api/meshcom/nodes?bbox=&call=&maxAge=&limit=` | MeshCom nodes with a known position as this instance's node(s) heard them: how (`direct`, `relayed`, `server`, `node`), device, firmware, a signal-quality and battery bucket; signed-in members also get the exact battery, RSSI and SNR (`exact: true`). `bbox` is `minLon,minLat,maxLon,maxLat`; `call` narrows to one callsign; `maxAge` ≤ 7 d (default 1 d); `limit` ≤ 1000 | public |
| GET | `/api/meshcom/links?bbox=&maxAge=&limit=` | Links between MeshCom nodes whose both ends have a known position (`direct`, or a `relay` leg), with a quality bucket; exact averages for signed-in members. `maxAge` ≤ 48 h (default 24 h) | public |
| POST | `/api/decode` | Decode a raw TNC2 line | public |
| GET | `/api/ports` · `/api/messages` | Transport status · APRS message log | public |
| POST | `/api/tx/aprs` | Gated user APRS TX | session (verified callsign) |
| GET/POST | `/api/my/stations`, `/:sid`, `/:sid/wx-key`, `/:sid/cache` | Manage your own stations; issue a weather key; make one a cache | session |
| POST | `/api/me/cache` | Become a living cache yourself (your beacon is the cache position) | session |
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
| GET · POST | `/federation/peers` · `/peers/trust` | Peer list + health · set trust | sysop or x-operator-secret |
| POST | `/federation/peers/44net` | Add a peer by ARDC-verified `<call>.ampr.org` binding (DNSSEC auto-admits, else confirm) | sysop or x-operator-secret |
| GET | `/federation/sync/:type` | CBOR sync page of signed fedwire frames (the canonical wire; see the federation wire format) | public |
| POST | `/federation/sync` | Pull from all peers; an optional JSON body `{types?, maxPages?}` narrows it to some feeds (deletes always come too) and a page cap. Answers the counts and the bytes read | sysop or x-operator-secret |
| POST | `/federation/corroborate` | Cross-instance corroboration query | public (rate-limited; `x-fed-secret` if configured) |
| POST | `/federation/notify` | Gossip "come pull" ping | public |
| POST | `/federation/submit` | Hub accepts a spoke's signed records | x-fed-secret (`FED_SUBMIT_SECRET`) |
| POST | `/federation/frames` | Connected-mode delivery of a CBOR sync page (AX.25/NET-ROM binding); frames are signature-verified | x-ingest-secret, sysop or x-operator-secret |
| GET · POST | `/federation/beacon` | Beacon-tier presence: serve our signed single-frame record · apply a heard one (trust-gated) | public · x-ingest-secret, sysop or x-operator-secret |
| POST | `/federation/bbs/enqueue` | Queue federation records for the FBB store-and-forward carrier | sysop or x-operator-secret |
| POST · GET | `/federation/relay/:instance/query`, `/lease`, `/answer`, `/result/:id` | The poll-based rendezvous relay | x-relay-secret |
| POST | `/federation/relay/:instance/dispatch` | Pack a packet-only spoke's queued queries into an FBB bulletin | sysop or x-operator-secret |

## Remote box

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/api/box/:id/pair` | The box obtains a one-time pairing code (`{ code, expiresAt }`, 15 min) to print for its operator | x-ingest-secret |
| POST | `/api/box/:id/claim` | Link the box to the signed-in account with that code (`{ code }`); single-use | session |
| POST | `/api/box/:id/command` | Enqueue a command (TX kinds need a verified callsign); `403 { pair: true }` until the box is paired to the session's account | session (paired owner) or x-ingest-secret |
| GET · POST | `/api/box/:id/commands` · `/commands/ack` | Box leases · acks commands | x-ingest-secret |
| GET | `/api/box/:id/log` | Operator view of command activity | session (paired owner) or x-ingest-secret |

## Admin / sysop

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/whoami` | Whether the caller is an operator; `pending: "verify"` for the unconfirmed holder of an `ADMIN_CALLSIGNS` call |
| GET · POST | `/api/admin/verifications` | List · add manual callsign verifications (`{ callsign, note }`) |
| DELETE | `/api/admin/verifications/:call` | Revoke a manual verification |
| GET · POST | `/api/admin/adoptions` | Withdrawn-owner caches, offers with their pending requests and the recent trail · offer a cache (`{ cacheId \| code, note }`) |
| DELETE | `/api/admin/adoptions/:cacheId` | Withdraw an offer (cancels its pending requests) |
| POST | `/api/admin/adoptions/:cacheId/assign` | Hand a cache to a control-verified call (`{ callsign, note, activate? }`) |
| POST | `/api/admin/adoptions/requests/:id/approve` · `/decline` | Decide an adoption request (`{ note? }`) |
| GET | `/api/admin/setup` | The first-hour setup checklist, checked live (secrets reported as set/unset only) |
| GET | `/api/admin/station-status` | A read-only summary for the operator's scripts: stations heard in the last hour, each port's recent packets and last hearing, and received messages to the operator's calls (any SSID) since `?since=<unix time>` (default the last hour, at most a week back, 20 at most). Sysop or `x-operator-secret` |
| GET | `/api/admin/setup/44net` | The read-only 44Net self-check: A record, `_aprscaching` TXT and descriptor endpoint, each pass/warn/fail with a fix (sysop or x-operator-secret) |
| GET/POST | `/api/node/nodes` · GET `/api/node/mheard` | NET/ROM NODES table (public read; the POST mirror takes x-ingest-secret, sysop or x-operator-secret) · MHeard |
| GET/POST/DELETE | `/api/bbs/forward`, `/forward/:id`, `/partners`, `/partners/:id` | FBB forwarding rules + partners (the partner-list read is also open to x-ingest-secret, for the ingest box's scheduler) |

All admin writes are **sysop**-gated server-side; each also accepts `x-operator-secret` for scripts.

## Ingest & BBS backend

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ingest` | Ingest positions/finds/packets (`x-ingest-secret` or on-device signed) |
| GET · POST | `/outbox` · `/outbox/ack` | Box pulls / acks queued APRS-IS messages |
| GET · POST · POST | `/api/bbs/forward/pool` · `/api/bbs/forward/inbound` · `/api/bbs/forward/sent` | FBB forwarding backend for the ingest box (x-ingest-secret) |
| GET · POST | `/api/bbs/session` · `/api/bbs/kill` | Connected-mode BBS session state · end a session (x-ingest-secret) |
| POST | `/api/import/:source` | Import an external catalog — see [Administration](../operate/administration.md#import-heritage-places) (x-ingest-secret) |

## Accounts, identity & GDPR

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/auth/passkey/*`, `/auth/email/start`, `/auth/claim`, `/auth/logout` | Passkey + email sign-in, claim, sign-out. `/auth/claim` and passkey registration answer with a `licence` result for the call (nothing is stored) | public → session |
| GET · POST | `/auth/email/verify` | The magic link (on the gateway's own origin, which is `APP_URL` where the two share a host): GET shows a confirm page (or `{ confirm: true }` to an API client) and never signs in; POST `{ token }` (JSON or the confirm form) spends the token and opens a session, and a JSON answer carries the call's `licence` result. A browser POST from another origin is refused | public → session |
| POST | `/auth/logout-all` | Sign out every session of the account, on every device | session |
| GET/POST | `/auth/session`, `/auth/callsign(s)`, `/auth/profile` | Session + base-callsign management. `GET/POST /auth/callsigns` carry a `licence` result per call, beside `verified` | session |
| POST | `/verify/aprs/start` | Start callsign control-verification: returns `{ code, to, text, expiresAt, sites }`, the message to transmit and the attested site calls listening for it; sends nothing. Completed when an attested site hears `text` on the air (a TNC, or a MeshCom node hearing it directly over LoRa) — method `rf_heard`. `409 { reason: "no_receiving_site" }` when `FIRST_PARTY_SITES` names no site, since nothing could hear the reply | session (holds the call) |
| GET | `/verify/aprs/status?callsign=` | `{ verified }` for the base call | public |
| GET | `/verify/methods` | `{ methods: { rf_heard, ampr_dns, lotw }, rfSites }` — which methods this instance offers (`rf_heard` needs an attested site in `FIRST_PARTY_SITES`, listed in `rfSites`; `lotw` needs `LOTW_CA_PEM`) | public |
| POST | `/verify/ampr/start` | `{ callsign }` → `{ code, name, type, value, record, expiresAt }`: the TXT record to publish at `_aprscaching.<call>.ampr.org` (valid 48 h) | session (holds the call) |
| POST | `/verify/ampr/check` | `{ callsign }` → looks the record up over DoH; verifies (method `ampr_dns`) → `{ verified, callsign, method, proof }` when the TXT at that exact name (no CNAME) carries the current code and the answer is DNSSEC-validated (`proof: "dnssec"`) or returned alike by every independent resolver that answered, at least 2 (`proof: "<n> resolvers"`). `422` with the reason otherwise (a name not published yet costs no attempt), `502` when too few resolvers answer | session (holds the call) |
| POST | `/verify/lotw/start` | `{ callsign }` → `{ challenge, message, algorithm, expiresAt }`: the exact `message` to sign (valid 15 min); `503` when no LoTW CA is configured | session (holds the call) |
| POST | `/verify/lotw/complete` | `{ callsign, certificates: [base64 DER…], signature: base64 }` — RSASSA-PKCS1-v1_5/SHA-256 over `message` with the LoTW callsign certificate's key; verifies (method `lotw`) when the signature, the chain to a trusted LoTW CA, the dates and the certificate's callsign check out | session (holds the call) |
| POST | `/verify/operator` | Verify an `ADMIN_CALLSIGNS` call (method `operator`) — the operator CLI | x-operator-secret |
| POST | `/auth/operator-link` | Mint a single-use, 15-minute sign-in link `{ callsign }` → `{ link, callsign, account, expiresIn }`; the link opens `/auth/email/verify`. Every call on an off-grid instance (no https `APP_URL`, no email), only `ADMIN_CALLSIGNS` calls otherwise — `tools/admin/signin-link.mjs` | x-operator-secret |
| GET | `/api/licence/:call` | Callsign **validity** from imported public licence registers: `{ callsign, status, source?, sourceName?, expiresAt?, checkedAt? }`, `status` one of `licensed`, `expired`, `unconfirmed`. The call is normalised to its home call (`OE/DL1ABC/P` → `DL1ABC`). Never control-verification; see [Licence registers](licence-sources.md) | rate-limited |
| GET | `/api/licence` | The imported registers: `{ sources: [{ source, sourceName, rows, importedAt }] }` | rate-limited |
| POST | `/api/licence/import` · `/api/licence/import/finish` | Register import from `tools/licence/import.mjs`: batches of `{ source, importedAt, rows: [[callsign, status, expiresAt]] }` (≤ 1000), then `{ source, importedAt, count }` closes the run and removes calls the register no longer lists (`409` and no pruning when the count differs) | x-operator-secret |
| POST · GET | `/keys/register` · `/keys/:call` | Register a device key for a call the session's account holds · list a callsign's keys | session · public |
| POST | `/api/account/:call/export`, `/delete`, `/bundle`, `/move`, `/api/account/import` | GDPR export/erase + account portability | signed-body |
| GET/PUT | `/api/prefs` · `/api/notify/prefs` | Preferences · notification settings | session |
| GET · POST · DELETE | `/api/watch/alerts` · `/api/watch/seen` · `/api/watch/:id` | Watchlist alerts · mark seen · stop watching | session |
| GET · POST | `/api/push/key` · `/api/push/subscribe` · `/api/push/unsubscribe` | Web-push public key · (un)subscribe this browser | session |
| GET/POST · GET | `/api/views` · `/v/:id` | Saved map views · resolve a shared view | session · public |

## BBS (public)

| Method | Path | Purpose |
|--------|------|---------|
| POST · GET | `/api/bbs/messages`, `?to=`, `/api/bbs/sent?from=`, `/api/bbs/bulletins`, `/api/bbs/thread/:id` | Store-and-forward mail + bulletins |
| POST | `/api/bbs/messages/:id/read` | Mark a message read |
| GET | `/api/bbs/route` · `/api/bbs/wp` | Hierarchical routing lookup · White Pages directory |

## Misc

`GET /health` (readiness; `?live` for liveness) · `/source` + `/.well-known/source` (running source) ·
`/imprint` + `/privacy` (legal pages from `OPERATOR_*`) · `/sitemap` (human-readable site map) ·
`/support` + `/api/support` · `GET/POST /api/support/prefs` + `POST /api/support/confirm`
(supporter recognition; prefs are session-gated, confirm is x-operator-secret) · `/sitemap.xml` +
`/api/sitemap` (JSON) + `/robots.txt` · `/feeds/*.xml` (RSS: activity, caches, bulletins, leaderboard,
per-user) · `/badge/:call.svg` (embeddable network badge) · `/embed` + `/embed/qr.svg` (embeddable map +
QR; the map takes `?cache=` or `?bbox=`, loads MapLibre from the instance's web app and its basemap from
[`BASEMAP_STYLE`](configuration.md#gateway-read-api-spots-emailpush)) · `DELETE /api/views/:id` (remove a saved view).

## Scheduled tasks

On a cron the gateway prunes TTL'd firehose positions, the raw-packet ring and stale relay
queue entries; then pulls federation (`syncAllPeers`), runs push-to-hub and the relay spoke leg (both no-ops
unless configured), and sends watch-alert email digests.
