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
    The Cloudflare Worker supports every variable below. The **Node and Bun** servers map a subset: the
    public-read-API rate limits, activity spots, email/push, and a few others are **Worker-only**, and the
    **Bun** server additionally does not read `ADMIN_CALLSIGNS` (so the Bun single-binary topology has no web
    sysop surface).

## Gateway — core & instance

| Variable | Purpose | Default |
|---|---|---|
| `INGEST_SECRET` | Shared secret for `/ingest` and operator backend calls (`x-ingest-secret`). **Required** — the Node/Bun servers refuse to boot, and no session is ever minted or honored, while it is unset or `change-me` | *(required)* |
| `SESSION_SECRET` | Dedicated session-signing secret. Recommended on shared gateways so the ingest-box credential cannot forge user sessions; absent ⇒ sessions derive from `INGEST_SECRET` | — |
| `INSTANCE` | Canonical federation instance id / domain | `aprscaching.local` |
| `APP_URL` | App origin for magic-link redirects *(Worker)* | — |
| `RP_ID` | WebAuthn relying-party id (registrable domain) *(Worker)* | — |
| `SOURCE_REPO` | AGPL §13 published-source URL — a public fork **must** set this | upstream |
| `SOURCE_COMMIT` / `SOURCE_TAG` / `SOURCE_BUILT_AT` | Running-source descriptor | git HEAD |
| `ADMIN_CALLSIGNS` | Comma-separated licensed calls that may administer this instance (sysop) | — |
| `BBS_CALL` | Relay callsign personal mail is delivered from | `APRSCG` |

Node/Bun servers also read plain runtime knobs that are not part of the gateway config object: `PORT`
(`8787`), `DB_PATH`, `MIGRATIONS_DIR` (`db/migrations`), `MEDIA_DIR`, and `FED_SYNC_INTERVAL_MS` (`300000`;
`0` disables scheduled peer sync).

## Gateway — verification & retention

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_PARTY_SITES` | Allowlist of IGate/site callsigns you operate and attest — the only Tier-A origin. Tier A is default-deny: unset ⇒ no find reaches Tier A locally (peer corroboration over federation still can) | — |
| `FED_CORROBORATION_QUORUM` | Distinct instances required to promote a find to Tier A | `1` |
| `DOH_URL` | DNS-over-HTTPS resolver for 44net peer onboarding (must return the DNSSEC AD flag) | Cloudflare |
| `FED_ENDPOINTS` | This instance's typed transport endpoints (JSON array of `{transport,address,priority}`), published as `addresses` in the descriptor | — |
| `FED_AUTO_PROMOTE` | Confirmed-corroboration count to auto-promote an unvetted peer (`0` = off) | `0` |
| `FED_CORROBORATION_SECRET` | If set, `/federation/corroborate` requires `x-fed-secret` | — |
| `FED_REVEAL_IGATE` | Include the exact IGate in corroboration responses (both peers opt in) | off |
| `FED_CORROBORATION_GRID_DEG` / `_TIME_BUCKET_SEC` / `_DIST_BUCKET_M` | Location/time coarsening of corroboration queries | `0.005` / `600` / `100` |
| `TOMBSTONE_TTL_DAYS` | Retention of GDPR delete tombstones | `180` |
| `PACKETS_TTL_HOURS` | Retention of the workbench raw-packet ring *(Worker)* | `24` |

## Gateway — federation

| Variable | Purpose | Default |
|---|---|---|
| `FED_PRIVATE_KEY` | Ed25519 signing key (base64 JSON) — if set, feeds are signed | — |
| `FED_KEY_HISTORY` / `FED_ROTATIONS` | Previous keys + signed rotations for key rollover | — |
| `FED_REGISTRY` / `FED_REGISTRY_KEY` | Signed instance registry + the authority key that verifies it | — |
| `FED_REGISTRY_DNS` | Alternative registry source: a DNS-TXT record name *(Worker)* | — |
| `FED_OPERATOR` / `FED_APRS_CALL` | Operator label + APRS service callsign, self-published in `/.well-known` | — |
| `FED_PEERS` | Comma-separated peer base URLs to sync from | — |
| `FED_DISCOVER` | Auto-adopt peers advertised by peers (transitive discovery) | off |
| `FED_SUBMIT_SECRET` | **Hub:** enables `POST /federation/submit`. **Spoke:** the push secret | — |
| `FED_SUBMIT_INSTANCES` | Hub allowlist of submitter instances | any non-self |
| `FED_HUB_URL` | Spoke: a reachable hub to push signed records to | — |
| `FED_RELAY_SECRET` | Shared secret for the rendezvous relay (hub + spoke) | — |
| `FED_AMATEUR_ENDPOINT` | Reserved: a 44net/HAMNET address (reachability, trust-neutral) *(Worker)* | — |

## Gateway — read API, spots, email/push (Worker)

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

## Ingest box

Core forwarding and the APRS-IS feed are always available; every RF transport below is opt-in and activates
only when its variable is present.

**Core / APRS-IS feed**

| Variable | Purpose | Default |
|---|---|---|
| `INGEST_URL` | Gateway ingest endpoint to POST batches to | `http://127.0.0.1:8787/ingest` |
| `INGEST_SECRET` | Sent as `x-ingest-secret` | `change-me` |
| `BATCH_MS` | Batch flush interval | `1500` |
| `APRSIS_HOST` / `APRSIS_PORT` | APRS-IS server | `rotate.aprs2.net` / `14580` |
| `APRSIS_CALLSIGN` / `APRSIS_PASSCODE` / `APRSIS_FILTER` | IS login + server-side filter | `N0CALL` / `-1` / `r/47.07/15.42/300` |

**RF transports** — full details and semantics in [RF ingest & transports](../operate/rf-ingest.md).

| Subsystem | Variables |
|---|---|
| KISS TNC (gates digi/node/BBS/IGate) | `KISS_TNC_HOST`, `KISS_TNC_PORT` (`8001`) |
| AGWPE | `AGWPE_HOST`, `AGWPE_PORT` (`8000`), `AGWPE_RADIO_PORT` (`0`) |
| WA8DED hostmode | `HOSTMODE_HOST`, `HOSTMODE_PORT` (`3694`), `HOSTMODE_MYCALL`, `HOSTMODE_RADIO_PORT` |
| Meshtastic | `MESH_HOST`, `MESH_PORT` (`1883`) |
| TAK / CoT in | `TAK_COT_PORT`, `TAK_COT_BIND` |
| AXUDP | `AXUDP_PORT`, `AXUDP_BIND`, `AXUDP_PEERS` |
| AXIP | `AXIP_ENABLE`, `AXIP_PEERS`, `AXIP_BIND` |
| Digipeater | `DIGI_CALL`, `DIGI_ALIASES` (`WIDE1,WIDE2`), `DIGI_CONNECTED`, `DIGI_VISCOUS_MS` |
| NET/ROM node | `NETROM_CALL`, `NETROM_ALIAS`, `NETROM_BROADCAST_MS` (`300000`), `NETROM_PATH_QUALITY` |
| BBS (inbound + forwarding) | `BBS_NODE_CALL`, `BBS_FORWARD`, `BBS_FORWARD_CALL`, `BBS_FORWARD_POLL_MS` (`60000`), `BBS_FORWARD_SID` |
| IGate | `IGATE_CALL`, `IGATE_PASS`, `IGATE_FILTER`, `IGATE_LOCAL_TTL` |
| Announce / WX uplink (opt-in TX) | `APRSIS_SERVICE_CALL`, `APRSIS_SERVICE_PASS`, `CWOP_HOST`, `CWOP_PORT` (`14580`) |

## Web build

Build-time variables (`import.meta.env.VITE_*`) baked into `apps/web`.

| Variable | Purpose | Default |
|---|---|---|
| `VITE_API_BASE` | Gateway base URL | `http://127.0.0.1:8787` |
| `VITE_BASEMAP` | `offline` uses the self-contained graticule; else keyless demo tiles | online |
| `VITE_SAT_TILES` / `VITE_SAT_ATTRIBUTION` | Satellite raster layer URL + attribution | EOX Sentinel-2 |
| `VITE_TOOL_REGISTRY` | Signed tool-registry URL | `/tools/registry.json` |
| `VITE_TOOL_REGISTRY_AUTHORITY` | Pinned Ed25519 authority key the registry is verified against | (built-in) |
