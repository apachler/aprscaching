# Configuration reference

Every setting is an environment variable. The **gateway** reads its configuration from the runtime
environment (Cloudflare `wrangler.toml` vars / secrets, or the process environment for the Node and Bun
servers). The **ingest box** and the **web build** have their own separate variable namespaces.

!!! warning "Secrets stay in the environment"
    `INGEST_SECRET`, `FED_PRIVATE_KEY`, `ADMIN_CALLSIGNS`, `FED_SUBMIT_SECRET`, and `FED_RELAY_SECRET` are
    security-critical and must never be settable at runtime or exposed to the client — supply them only
    through the environment (or `wrangler secret`). Other secrets: `APRSIS_PASSCODE`, `IGATE_PASS`,
    `APRSIS_SERVICE_PASS`, `FED_CORROBORATION_SECRET`, `EMAIL_API_KEY`, `VAPID_PRIVATE`, `OKAPI_KEY`.

!!! note "Runtime coverage"
    **Every gateway variable below works on every runtime** — the Node and Bun servers forward the
    complete config-key set from the process environment (`ENV_STRING_KEYS` in the gateway's `env.ts`
    is the single source of truth), so sysop admin, rate limits, spots, email/push, and first-party
    attestation are all live on self-host too. The only real runtime differences are infrastructural:
    the Worker runs scheduled work on cron triggers (self-host uses in-process intervals), stores in
    D1/R2 (self-host: SQLite/filesystem), and takes secrets via `wrangler secret`.

## Gateway — core & instance

| Variable | Purpose | Default |
|---|---|---|
| `INGEST_SECRET` | Shared secret for `/ingest` and operator backend calls (`x-ingest-secret`). **Required** — the Node/Bun servers refuse to boot, and no session is ever minted or honored, while it is unset or `change-me` | *(required)* |
| `SESSION_SECRET` | Dedicated session-signing secret. Recommended on shared gateways so the ingest-box credential cannot forge user sessions; absent ⇒ sessions derive from `INGEST_SECRET` | — |
| `INSTANCE` | Canonical federation instance id / domain | `aprscaching.local` |
| `APP_URL` | App origin for magic-link redirects | — |
| `RP_ID` | WebAuthn relying-party id (registrable domain) | — |
| `SESSION_TTL_DAYS` | Session cookie lifetime | `30` |
| `SESSION_EPOCH` | Bump to invalidate every outstanding session (key-compromise recovery) | — |
| `TRUST_PROXY` | Trust `x-forwarded-for` for rate-limit client identity (set only behind your own proxy) | off |
| `CORS_ORIGINS` | Extra origins allowed for credentialed CORS (comma-separated) | — |
| `ALLOW_DEV_TOKENS` | Return magic-link tokens in-band instead of emailing (dev/CI only — never production) | off |
| `SOURCE_REPO` | AGPL §13 published-source URL — a public fork **must** set this | upstream |
| `SOURCE_COMMIT` / `SOURCE_TAG` / `SOURCE_BUILT_AT` | Running-source descriptor | git HEAD |
| `ADMIN_CALLSIGNS` | Comma-separated licensed calls that may administer this instance (sysop) | — |
| `OPERATOR_NAME` / `OPERATOR_ADDRESS` / `OPERATOR_EMAIL` | Operator identity for the per-instance `/imprint` + `/privacy` pages ("," separates address lines). A public instance **must** set these — until then both pages render a visible not-configured warning | — |
| `BBS_CALL` | Relay callsign personal mail is delivered from, and the service call radio commands (`FOUND` / `DNF` / `NOTE` / `HELP`) are addressed to | `APRSCG` |
| `RADIO_REPLIES` | `1` sends a fixed text reply to each radio command; the protocol ack and the `HELP` reply go out regardless. Answers go back through the ingest box that heard the message when it can transmit (`BOX_ID`, `BOX_TX=1`, and a TNC or `MESHCOM_TX=1`); otherwise APRS answers go through the box's APRS-IS uplink (`APRSIS_SERVICE_CALL`) | off |

Node/Bun servers also read plain runtime knobs that are not part of the gateway config object: `PORT`
(`8787`), `DB_PATH`, `MIGRATIONS_DIR` (`db/migrations`), `MEDIA_DIR`, and `FED_SYNC_INTERVAL_MS` (`300000`;
`0` disables scheduled peer sync).

## Gateway — verification & retention

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_PARTY_SITES` | Allowlist of IGate/site callsigns you operate and attest — the only Tier-A origin. Tier A is default-deny: unset ⇒ no find reaches Tier A locally (peer corroboration over federation still can), and this instance answers peers' corroboration requests only from positions heard through these sites | — |
| `FED_CORROBORATION_QUORUM` | Distinct corroborating identities (registry operator, else signing key) required to promote a find to Tier A | `2` |
| `DOH_URL` | DNS-over-HTTPS resolver for 44net peer onboarding (must return the DNSSEC AD flag) | Cloudflare |
| `FED_ENDPOINTS` | This instance's typed transport endpoints (JSON array of `{transport,address,priority}`), published as `addresses` in both the descriptor and the registry self-entry | — |
| `FED_AUTO_PROMOTE` | Confirmed-corroboration count to auto-promote an unvetted peer (`0` = off) | `0` |
| `FED_CORROBORATION_SECRET` | If set, `/federation/corroborate` also requires `x-fed-secret`; an asker sends it only to trusted `https` peers | — |
| `FED_CORROBORATION_REQUIRE_KNOWN` | `1`: answer corroboration questions only from known, non-blocked peers (verified by their key) | off |
| `FED_REVEAL_IGATE` | Include the exact IGate in corroboration answers, and accept it in answers received (both peers opt in) | off |
| `FED_CORROBORATION_GRID_DEG` / `_TIME_BUCKET_SEC` / `_DIST_BUCKET_M` | Location/time coarsening of corroboration queries | `0.005` / `600` / `100` |
| `TOMBSTONE_TTL_DAYS` | Retention of GDPR delete tombstones | `180` |
| `PACKETS_TTL_HOURS` | Retention of the Shack raw-packet ring | `24` |
| `MESSAGES_TTL_DAYS` / `SENSOR_TTL_DAYS` / `PORTSTATS_TTL_DAYS` / `ALERTS_TTL_DAYS` / `MHEARD_TTL_DAYS` | Retention of messages, telemetry/WX samples, port statistics, watch alerts, and the node MHeard list | built-in |

## Gateway — federation

| Variable | Purpose | Default |
|---|---|---|
| `FED_PRIVATE_KEY` | Ed25519 signing key (base64 JSON) — if set, feeds are signed | — |
| `FED_KEY_HISTORY` / `FED_ROTATIONS` | Previous keys (each with an `until`) + signed rotations for key rollover | — |
| `FED_ROTATION_GRACE_DAYS` | Days a rotated-away key keeps verifying when its history entry names no `until`; also the grace `rotatekey.mjs` writes | 7 |
| `FED_REGISTRY` / `FED_REGISTRY_KEY` | Signed instance registry + the pinned authority key that verifies it (required whenever a registry is configured) | — |
| `FED_REGISTRY_DNS` | Alternative registry source: a DNS `TXT` record name whose `url=` locates the document; verified under `FED_REGISTRY_KEY` (without it the server refuses to start) | — |
| `FED_OPERATOR` / `FED_APRS_CALL` | Operator label + APRS service callsign, self-published in `/.well-known` | — |
| `FED_PEERS` | Comma-separated peer base URLs to sync from | — |
| `FED_DISCOVER` | Learn the https peers trusted peers advertise, added `unvetted` and disabled (at most 200) | off |
| `FED_ALLOW_PRIVATE` | `1`: federation may fetch private and loopback addresses (Node/Bun; configured `FED_PEERS`/`FED_HUB_URL` are always allowed) | off |
| `FED_SUBMIT_SECRET` | **Hub:** enables `POST /federation/submit`. **Spoke:** the push secret | — |
| `FED_SUBMIT_INSTANCES` | Hub allowlist of submitter instances | any non-self |
| `FED_HUB_URL` | Spoke: a reachable hub to push signed records to | — |
| `FED_RELAY_SECRET` | Enables the rendezvous relay and gates enqueueing and results; spokes lease and answer by signing with their own key | — |

## Gateway — read API, spots, email/push

| Variable | Purpose | Default |
|---|---|---|
| `API_RATE_WINDOW_SEC` / `API_RATE_ANON` / `API_RATE_KEYED` | Public read-API rate limits | `60` / `60` / `600` |
| `API_MAX_BBOX_DEG` | Maximum bounding-box side for `/api/v1` reads | `20` |
| `SPOTS_ENABLED` | Enable outbound activity-spot polling | off |
| `SPOTS_SOURCES` / `SPOTS_TTL_SEC` / `SPOTS_*_URL` | Spot source allowlist, cache TTL, per-source endpoint overrides | built-in |
| `EMAIL_FROM` / `EMAIL_API_KEY` | Magic-link email sender (absent ⇒ dev mode, no send) | — |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT` | Web-push keys (absent ⇒ push off) | — |
| `OKAPI_BASE` / `OKAPI_KEY` | OpenCaching import node + consumer key | — |
| `SUPPORT_*` | Donation links surfaced on `/support` (recognition only) | — |
| `COT_STREAM_INTERVAL_MS` / `COT_STREAM_MAX_MS` | TAK CoT SSE stream: push interval + max connection lifetime | built-in |

## Ingest box

Core forwarding and the APRS-IS feed are always available; every RF transport below is opt-in and activates
only when its variable is present.

**Core / APRS-IS feed**

| Variable | Purpose | Default |
|---|---|---|
| `INGEST_URL` | Gateway ingest endpoint to POST batches to | `http://127.0.0.1:8787/ingest` |
| `INGEST_SECRET` | Sent as `x-ingest-secret` | `change-me` |
| `BATCH_MS` | Batch flush interval | `1500` (`2000` in the Docker stack) |
| `INGEST_SPOOL_MAX` | Undelivered-packet spool bound (drop-oldest) during a gateway outage | `5000` |
| `APRSIS_HOST` / `APRSIS_PORT` | APRS-IS server | `rotate.aprs2.net` / `14580` |
| `APRSIS_CALLSIGN` / `APRSIS_PASSCODE` / `APRSIS_FILTER` | IS login + server-side filter | `N0CALL` / `-1` / `r/47.07/15.42/300` |

**RF transports** — full details and semantics in [RF ingest & transports](../operate/rf-ingest.md).

| Subsystem | Variables |
|---|---|
| KISS TNC (gates digi/node/BBS/IGate) | `KISS_TNC_HOST`, `KISS_TNC_PORT` (`8001`) |
| AGWPE | `AGWPE_HOST`, `AGWPE_PORT` (`8000`), `AGWPE_RADIO_PORT` (`0`) |
| WA8DED hostmode | `HOSTMODE_HOST`, `HOSTMODE_PORT` (`3694`), `HOSTMODE_MYCALL`, `HOSTMODE_RADIO_PORT` |
| Meshtastic (licensed nodes only) | `MESHTASTIC_HOST`, `MESHTASTIC_PORT` (`4403`) — the node's TCP API; `MESHTASTIC_MQTT_URL` (`mqtt://` or `mqtts://`, credentials in the URL), `MESHTASTIC_MQTT_TOPIC` (`msh/#`) — a broker's protobuf feed |
| MeshCom | `MESHCOM_NODE` (node address(es), each optionally `=CALL`; enables the listener), `MESHCOM_PORT` (`1799`), `MESHCOM_BIND` (default: this host's address on the node's subnet), `MESHCOM_FANOUT` (`host:port` list), `MESHCOM_RATE` (`20`/s per node), `MESHCOM_STALE_MIN` (`30`); transmit: `MESHCOM_TX` (`1` lets the box answer radio commands through its nodes), `MESHCOM_TX_CALL` (the operator's call, which must match the node's; default `BOX_CALL`, then `IGATE_CALL`, `DIGI_CALL`), `MESHCOM_TX_AUDIT` (JSON-lines audit file) |
| AXUDP | `AXUDP_PORT`, `AXUDP_BIND`, `AXUDP_PEERS` |
| AXIP | `AXIP_ENABLE`, `AXIP_PEERS`, `AXIP_BIND` |
| Digipeater | `DIGI_CALL`, `DIGI_ALIASES` (`WIDE1,WIDE2`), `DIGI_CONNECTED`, `DIGI_VISCOUS_MS` |
| NET/ROM node | `NETROM_CALL`, `NETROM_ALIAS`, `NETROM_BROADCAST_MS` (`300000`), `NETROM_PATH_QUALITY`, `NETROM_INP3` (`1` also speaks INP3 alongside NODES), `NODE_PERSONALITY` (`netrom` \| `flexnet` \| `tnn` \| `baycom` command surface) |
| BBS (inbound + forwarding) | `BBS_NODE_CALL`, `BBS_FORWARD`, `BBS_FORWARD_CALL`, `BBS_FORWARD_POLL_MS` (`60000`), `BBS_FORWARD_SID`, `BBS_FORWARD_COMPRESS` (`1` offers LZHUF-B1 compressed forwarding; engages only when the partner's SID also advertises `B`) |
| IGate | `IGATE_CALL`, `IGATE_PASS`, `IGATE_FILTER`, `IGATE_LOCAL_TTL` |
| Receiving site (Tier A) | `RF_SITE_CALL` — names the box as the receiving site of frames its local TNCs (KISS, AGWPE, WA8DED host mode) hear directly (default `IGATE_CALL`); attest it with `FIRST_PARTY_SITES` on the gateway. Set it only for a TNC you operate — leave it unset when the TNC host is someone else's station |
| Remote control (Shack → Remote control) | `BOX_ID`, `BOX_TX` (`1` allows remote transmit), `BOX_CALL` (default `IGATE_CALL`, then `DIGI_CALL`), `BOX_TX_PATH` (`WIDE1-1,WIDE2-1`), `BOX_CMD_MAX_AGE` (`900` s), `BOX_POLL_MS` (`5000`), `BOX_SERVICE_CALL` (the gateway's `BBS_CALL`; the only inner source the box sends answers to radio commands from, default `APRSCG`) |
| Announce / WX uplink (opt-in TX) | `APRSIS_SERVICE_CALL`, `APRSIS_SERVICE_PASS`, `CWOP_HOST`, `CWOP_PORT` (`14580`) |

Where the box reads these: the process environment first, then `.env` in `apps/ingest/`, then `.env` at the
top of the checkout. Under Docker, `deploy/.env` reaches the container through the compose file; under
systemd, through `EnvironmentFile`. Put comments on their own lines — systemd does not strip a trailing
`# comment` from a value.

## Desktop app

The single-file desktop build (`deploy/desktop/`) runs the gateway and the web app together.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Local port for the app | `8787` |
| `DATA_DIR` | Where the database and media live | `%APPDATA%\aprscaching` · `~/Library/Application Support/aprscaching` · `$XDG_DATA_HOME/aprscaching` (`~/.local/share/aprscaching`) |
| `WEB_DIST` / `MIGRATIONS_DIR` | Serve the web app / apply migrations from disk instead of the copies built into the binary | built in |

## Web build

Build-time variables (`import.meta.env.VITE_*`) baked into `apps/web`.

| Variable | Purpose | Default |
|---|---|---|
| `VITE_API_BASE` | Gateway base URL | `http://127.0.0.1:8787` |
| `VITE_BASEMAP` | `offline` uses the self-contained graticule; else the online vector basemap | online |
| `VITE_BASEMAP_STYLE` | MapLibre style URL for the vector basemap (self-hosted tiles, commercial provider) | OpenFreeMap `liberty` |
| `VITE_SAT_TILES` / `VITE_SAT_ATTRIBUTION` | Satellite raster layer URL + attribution | EOX Sentinel-2 cloudless 2016 (CC-BY 4.0) |
| `VITE_TOOL_REGISTRY` | Signed tool-registry URL | `/tools/registry.json` |
| `VITE_TOOL_REGISTRY_AUTHORITY` | Pinned Ed25519 authority key the registry is verified against | (built-in) |
