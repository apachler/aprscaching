# Configuration reference

Every setting is an environment variable. The **gateway** reads its configuration from the runtime
environment: the process environment of the Node and Bun servers. The **ingest box** and the **web build** have their own separate variable namespaces.
Some of the gateway's policy values are also [instance settings](#instance-settings), which the sysop can
change in Instance admin while the instance runs.

Every setting has a type: a whole number, a number, one of a fixed set of values, a list, JSON, a URL or
free text. A set value that does not fit its type stops the Node and Bun servers and the ingest box from
starting; **Instance admin → Setup** reports the same check.

<!-- The key tables below are generated from the configuration schema (packages/shared/src/config.ts,
configkeys.ts, configdocs.ts): edit them there and run `node tools/config/generate.mjs`. -->

!!! warning "Secrets stay in the environment"
    `INGEST_SECRET`, `OPERATOR_SECRET`, `SESSION_SECRET`, `FED_PRIVATE_KEY`, `ADMIN_CALLSIGNS`,
    `FED_SUBMIT_SECRET`, and `FED_RELAY_SECRET` are
    security-critical and must never be settable at runtime or exposed to the client — supply them only
    through the environment. Other secrets: `APRSIS_PASSCODE`, `IGATE_PASS`,
    `APRSIS_SERVICE_PASS`, `FED_CORROBORATION_SECRET`, `EMAIL_API_KEY`, `SMTP_PASS`, `VAPID_PRIVATE`, `OKAPI_KEY`,
    `MESHCOM_KISS_PASS`, `MESHTASTIC_MQTT_URL` (when it carries credentials), `BOX_KEY`, `TUNNEL_TOKEN`,
    `CF_API_TOKEN`.

!!! note "Runtime coverage"
    **Every gateway variable below works on both runtimes** — the Node and Bun servers forward the
    complete config-key set from the process environment (the key list in the gateway's `env.ts`, from
    which its `Env` type is derived, is the single source of truth). Both run scheduled work on
    in-process intervals and store in SQLite and on the filesystem.

## Instance settings

Infrastructure and secrets live only in the environment. The policy values a sysop tunes while the instance
runs are **instance settings** (site settings): the sysop can also set them in **Instance admin → Instance
settings**, which stores them in the database ([Instance settings](../run/day-to-day/instance-settings.md)).
Each one has exactly one source, by this rule:

1. **The environment wins.** When the environment sets the key (a blank value counts as unset), that value
   applies, and the page shows it read-only as *Set by the environment*.
2. Otherwise the value saved on the page applies.
3. Otherwise the default below applies.

A value saved on the page applies at once, without a restart, and the moderation audit log records each
change. It travels with the database, so a backup carries it. The tables below mark each instance setting.

<!-- site-settings-table -->
| Setting | Variable | Group | Accepts |
|---|---|---|---|
| Lowest verified tier | `MIN_TRUST` | Game rules | one of `A`, `B` |
| Move a found cache | `CACHE_MOVE_LIMIT_M` | Game rules | a number, 0–100000 m |
| Hides per day | `HIDE_DAILY_LIMIT` | Game rules | a whole number, 0–1000 caches |
| Rate-limit window | `API_RATE_WINDOW_SEC` | Accounts & API | a whole number, 1–3600 s |
| Requests without a key | `API_RATE_ANON` | Accounts & API | a whole number, 1–100000 requests |
| Requests with a key | `API_RATE_KEYED` | Accounts & API | a whole number, 1–1000000 requests |
| API keys per account | `API_KEYS_PER_ACCOUNT` | Accounts & API | a whole number, 0–100 keys |
| Diagnostic data | `RETENTION` | Privacy & retention | a period per table, each a whole number |
| Reports and moderation log | `MODERATION_RETENTION_DAYS` | Privacy & retention | a whole number, 1–3650 days |
| MeshCom nodes | `MESHCOM_NODE_TTL_DAYS` | Privacy & retention | a whole number, 1–365 days |
| MeshCom links | `MESHCOM_LINK_TTL_HOURS` | Privacy & retention | a whole number, 1–8760 hours |
| Permitted import sources | `IMPORT_ALLOW` | Imports & data sources | any of `wwff`, `gcau`, `iota` |
| Activity spots | `SPOTS_ENABLED` | Imports & data sources | on or off |
| Spot sources | `SPOTS_SOURCES` | Imports & data sources | any of `pota`, `sota`, `gma`, `pskreporter`, `dxcluster`, `rbn` |
| Poll interval | `SPOTS_TTL_SEC` | Imports & data sources | a whole number, 60–86400 s |
| List trusted peers | `FED_PEER_EXCHANGE` | Federation | on or off |
| Pass on peers' records | `FED_RESERVE` | Federation | one of `trusted`, `all`, `off` |
| Players may add tool registries | `TOOL_REGISTRIES_PLAYERS` | Tools | on or off |
| Fetch tool registries through this instance | `TOOL_REGISTRIES_PROXY` | Tools | on or off |
| Operator name | `OPERATOR_NAME` | Imprint & contact | one line of text, up to 120 characters |
| Postal address | `OPERATOR_ADDRESS` | Imprint & contact | one line of text, up to 300 characters |
| Contact email | `OPERATOR_EMAIL` | Imprint & contact | an email address |
| Security contacts | `SECURITY_CONTACT` | Imprint & contact | email or `https:` addresses, up to 5 |
| Donation links | `SUPPORT_LINKS` | Support links | donation links (a label and an http(s) address), up to 12 |
| Look for new releases | `UPDATE_CHECK` | Updates | on or off |
<!-- /site-settings-table -->

## Gateway — core & instance

<!-- config-table:gateway-core -->
| Variable | Purpose | Default |
|---|---|---|
| `INGEST_SECRET` | The ingest-plane credential (`x-ingest-secret`): posting packets to `/ingest`, draining the outbox, BBS delivery and the FBB forwarding pool, the NET/ROM node mirror, heard federation frames, finds logged over APRS, and remote-box polling and pairing. It authorises nothing operator-level and never signs a session. **Required** — the Node/Bun servers refuse to boot while it is unset or `change-me` | *(required)* |
| `OPERATOR_SECRET` | The operator's machine credential (`x-operator-secret`) for instance-wide configuration from scripts: `POST /verify/operator` (`tools/admin/verify-call.mjs`), `POST /auth/operator-link` (`tools/admin/signin-link.mjs`), federation sync trigger, peer list and trust, 44net onboarding, FBB forwarding partners and rules, catalog imports and removing an imported place, the FBB federation enqueue, relay dispatch, and donation confirms. Unset ⇒ those machine paths are closed (a signed-in, verified sysop still administers the instance from the web). Must differ from `INGEST_SECRET` — the Node/Bun servers refuse to boot otherwise. Never give it to an ingest box | — |
| `SESSION_SECRET` | The session-signing key. **Required for sign-in**: unset, `change-me`, or equal to `INGEST_SECRET`/`OPERATOR_SECRET` ⇒ no session is minted or honoured. The Node/Bun servers and the desktop app generate one on first start when it is unset and keep it beside the database (`session.secret`, owner-only). Changing it signs every user out | *(generated on self-host)* |
| `APP_URL` | The main public origin people open (`https://aprs.example.net`, or `http://<LAN address>` off-grid): the canonical address of the sitemap, mails sent without a request (the digest) and the federation descriptor, the passkey origin, and the credentialed-CORS allowlist. A request on a host that is neither `APP_URL` nor in `EXTRA_ORIGINS` is answered as if it came to `APP_URL`. Passkeys need an `https` origin (or `http://localhost`); an `http` origin gets a session cookie without the `Secure` flag, which a browser would otherwise drop | — |
| `EXTRA_ORIGINS` | Further addresses of this instance, comma-separated bare origins with no path: `https://` for a name with a certificate (a 44Net name reachable from the internet), `http://` for a name or address on a network without one: a HAMNET host (not on the internet; the scheme declares it, since no address range tells HAMNET from 44Net) or a LAN. A request on one of them gets its session cookie, sign-in links and links into the app on that address; an `https` one also takes passkeys under `RP_ID` ([`/.well-known/webauthn`](api.md#authentication)), an `http` one signs in with an email link or the sysop's link. The Docker stack's Caddy serves each with automatic TLS or as plain http ([One instance, several addresses](../run/networks/several-addresses.md)). A gateway on another host than its web app (`VITE_API_BASE`) lists its own origin here | — |
| `INSTANCE` | Canonical federation instance id / domain. Set it only to differ from `APP_URL`'s host | `APP_URL`'s host, else the request host |
| `RP_ID` | WebAuthn relying-party id (registrable domain). Set it only to differ from `APP_URL`'s host — for example the parent domain, so passkeys work on several subdomains. Choose it before users register passkeys | `APP_URL`'s host; with a plain-http `APP_URL`, the host of the first https `EXTRA_ORIGINS` entry |
| `SESSION_TTL_DAYS` | Session cookie lifetime | `30` |
| `MEDIA_QUOTA_MB` | Megabytes of cache media (photos, sound, audio clues) the instance stores in all; past it, uploads are refused. Set it to what the disk or bucket can spare | `1024` |
| `HIDE_DAILY_LIMIT` | New caches one account may hide in 24 hours (its sysop excepted); `0` lifts the limit. Imports by the instance itself never count · *[Instance setting](#instance-settings)* | `5` |
| `SESSION_EPOCH` | Unix seconds: every session minted before it is refused (sign every user out without rotating `SESSION_SECRET`). One user signs out on every device with `POST /auth/logout-all` | — |
| `TRUST_PROXY` | Trust `x-forwarded-for` for rate-limit client identity (set only behind your own proxy; the Docker stack sets it, since Caddy is the only way in) | off |
| `TRUST_CF` | Keep Cloudflare's `cf-connecting-ip` as the rate-limit client identity. Set it only when the origin is reachable solely through Cloudflare (Tunnel, or proxied DNS with 80/443 firewalled to Cloudflare's ranges); otherwise a client-sent `cf-connecting-ip` is dropped. `compose.home.yml` sets it for the tunnel | off |
| `CORS_ORIGINS` | Extra origins allowed for credentialed CORS (comma-separated). With neither `APP_URL` nor `CORS_ORIGINS` set, cross-origin requests get `Access-Control-Allow-Origin: *` and never credentials — a SPA served from another origin (one built with `VITE_API_BASE` naming another host) needs its origin listed here | — |
| `ALLOW_DEV_TOKENS` | Return magic-link tokens in-band instead of emailing (dev/CI only — never production: it hands a sign-in token to whoever asks). An off-grid instance signs members in with the operator's one-time link instead ([`signin-link.mjs`](cli.md#signin-link)) | off |
| `OPERATOR_LINKS_FOR_ANY_CALL` | `1`: the operator's one-time sign-in link ([`signin-link.mjs`](cli.md#signin-link)) serves every call, not only `ADMIN_CALLSIGNS` calls, on an instance that also offers passkeys or email. For an off-grid station whose visitors have no other way in ([Visitors on the hotspot](../run/day-to-day/sign-in-links.md#visitors-on-the-hotspot)). A leaked `OPERATOR_SECRET` then reaches every account, so it stays off on a shared or public instance | off |
| `SOURCE_REPO` | AGPL §13 published-source URL — a public fork **must** set this | upstream |
| `SOURCE_COMMIT` / `SOURCE_TAG` / `SOURCE_BUILT_AT` | Running-source descriptor | git HEAD |
| `UPDATE_CHECK` | Once a day the gateway asks GitHub (`api.github.com`) for the newest APRScaching release, so **Instance admin** and `deploy/aprscaching doctor` can say when one is out ([Updates](../run/day-to-day/updates.md#how-you-hear-about-a-new-release)). The request names the instance in its User-Agent and carries nothing about a member. `0` stops it, for an off-grid instance or one that should not contact GitHub · *[Instance setting](#instance-settings)* | on |
| `TOOL_REGISTRIES` | The tool registries the **Tools** app lists, as a JSON array; the app ships no tools of its own, so players install theirs from these. Set, it replaces the list kept in **Instance settings**, which then shows it read-only. An item is `"builtin"` (the project registry bundled with the app) or `{"url", "authority", "label", "enabled"}`: `url` is an `https://` address, `github:owner/repo[/path][@ref]`, or a path on this instance; `authority` is the registry's pinned Ed25519 public key in base64url ([Tool registries](../run/day-to-day/instance-settings.md#tool-registries)) | the project registry |
| `TOOL_REGISTRIES_PLAYERS` | Players may add tool registries of their own, each pinned to its key and kept with their account. `0` hides and stops fetching them; they stay stored until the player removes them or the setting is on again · *[Instance setting](#instance-settings)* | on |
| `TOOL_REGISTRIES_PROXY` | The gateway fetches each added tool registry, and the manifests and scripts it lists, and serves them from this instance: players' addresses never reach the registry's host, and the last good copy keeps working offline. The browser still checks every signature. `0` lets browsers fetch registries directly · *[Instance setting](#instance-settings)* | on |
| `ADMIN_CALLSIGNS` | Comma-separated licensed calls that may administer this instance (sysop). The operator must also hold the call on their account and confirm it with `tools/admin/verify-call.mjs` (see [CLI](cli.md#operator-callsign)) | — |
| `OPERATOR_NAME` / `OPERATOR_ADDRESS` / `OPERATOR_EMAIL` | Operator identity for the per-instance `/imprint` + `/privacy` pages ("," separates address lines). A public instance **must** set these — until then both pages render a visible not-configured warning. `OPERATOR_EMAIL` also receives each player report when mail is configured ([Moderation](../run/day-to-day/moderation.md)) · *[Instance setting](#instance-settings)* | — |
| `SECURITY_CONTACT` | Where a security report goes: the `Contact:` lines of `/.well-known/security.txt` (RFC 9116), comma-separated `mailto:` or `https:` URIs (a bare address becomes `mailto:`). With neither this nor `OPERATOR_EMAIL` set, the file answers 404 · *[Instance setting](#instance-settings)* | `mailto:` + `OPERATOR_EMAIL` |
| `SERVICE_CALL` | The instance's one on-air call: radio commands (`FOUND` / `DNF` / `NOTE` / `HELP`) and callsign-verification messages (`VERIFY <code>`) are addressed to it, and acks and replies are sent from it. It must be a callsign with an SSID that no station of yours uses: MeshCom drops a direct message to an address without a digit | the first `ADMIN_CALLSIGNS` base call with `-15`; `APRSCG` without one |
| `RADIO_REPLIES` | `1` sends a fixed text reply to each radio command; the protocol ack and the `HELP` reply go out regardless. Answers go back through the ingest box that heard the message when it can transmit (`BOX_ID`, `BOX_TX=1`, and a TNC or `MESHCOM_TX=1`); otherwise APRS answers go through the box's APRS-IS uplink (`APRSIS_SERVICE_CALL`) | off |
<!-- /config-table -->

The Node and Bun servers also read plain runtime knobs that are not part of the gateway config object:

<!-- config-table:gateway-server -->
| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the server listens on | `8787` |
| `DB_PATH` | The SQLite database file | `data/aprscaching.db` beside the server |
| `MIGRATIONS_DIR` | Where the schema migrations are read from | `db/migrations` of the checkout |
| `MEDIA_DIR` | Where cache media is stored | `data/media` beside the server |
| `OFFLINE_TILES_PATH` | The offline map: a regional PMTiles archive of vector tiles, served at `/tiles/offline.pmtiles` for offline packs | none |
| `OFFLINE_TILES_URL` | The offline map archive hosted elsewhere (it must allow offline use and answer byte ranges with CORS); overrides the two above | none |
| `OFFLINE_TILES_ATTRIBUTION` | Shown on the offline map | `© OpenStreetMap contributors` |
| `OFFLINE_TILES_MAXZOOM` | The most detailed zoom a pack takes; a pack too large for it takes less | `14` |
| `FED_SYNC_INTERVAL_MS` | Milliseconds between scheduled peer syncs; `0` disables them | `300000` |
| `FED_RELAY_POLL_MS` | Milliseconds between relay rounds: a spoke collects the queries its hub holds for it, and an instance reads the answers to corroboration questions it left at a hub; `0` leaves both to the peer sync | `15000` |
| `WEB_DIST` | Node only: the built web app (`apps/web/dist`), served on the same origin as the API, for a box with no reverse proxy in front | — |
<!-- /config-table -->

The Node server can also listen for https itself, beside its plain port, for a station whose visitors reach
it on a Wi-Fi hotspot with no proxy in front. Off unless `HTTPS_PORT` is set; the Bun server and the desktop
app do not read these.

<!-- config-table:gateway-https -->
| Variable | Purpose | Default |
|---|---|---|
| `HTTPS_PORT` | Port of the https listener. It runs the same gateway, web app and live socket as the plain port, and the links it builds from a request say `https`. With it set, the plain port answers a page load from another device (a `GET` that accepts HTML, for a web-app route) with a `302` to the same host on `HTTPS_PORT`; loopback requests, the API, `/auth`, `/ingest`, `/federation`, `/ws`, a request a declared proxy (`TRUST_PROXY=1`) carried over https, and `/pocket-ca.crt` are served where they arrive. An operator sign-in link may then name `https://<private IPv4 address>:<HTTPS_PORT>` (see `OPERATOR_LINKS_FOR_ANY_CALL`). The server refuses to boot when it is set without `TLS_CERT` and `TLS_KEY` | off |
| `TLS_CERT` / `TLS_KEY` | PEM certificate (with any intermediate chain) and private key for `HTTPS_PORT`. `SIGHUP` reloads both without a restart — a certificate re-issued for a new hotspot address takes effect for new connections, and a file that fails to load keeps the previous one | — |
| `TLS_CA_CERT` | A CA certificate served read-only at `/pocket-ca.crt` (`application/x-x509-ca-cert`) on both ports, so a visitor can download and install the station's CA before trusting it. Only that fixed path reads it; unset ⇒ the path is a `404` | — |
<!-- /config-table -->

## Gateway — verification & retention

<!-- config-table:gateway-verification -->
| Variable | Purpose | Default |
|---|---|---|
| `FIRST_PARTY_SITES` | Receiving-site callsigns trusted for Tier A from configuration: the way to preset trusted stations for CI, scripted deploys and off-grid Desktop or Pocket instances. The primary way is **Instance admin → Trusted receiving stations** (and **Trust this station's hearings** on an enrolled box), where these calls show read-only as set in configuration; the trusted set is this list plus the stations trusted there. A site counts only for frames its own ingest box heard directly (a TNC or MeshCom port, delivered with the ingest secret or an enrolled box's key); an APRS-IS line naming the site (`qAR,<site>`) is never attested, since anyone can inject one. Trusted sites are also the only ones whose on-air copy of a `VERIFY <code>` message verifies a callsign. Tier A is default-deny: with no trusted station no find reaches Tier A locally (peer corroboration over federation still can), and this instance answers peers' corroboration requests only from positions it attests the same way | — |
| `MIN_TRUST` | The lowest tier a find needs to count as verified on this instance: `B` (Location-verified or better) or `A` (Radio-verified only). A cache's own minimum, set by its hider, takes precedence · *[Instance setting](#instance-settings)* | `B` |
| `CACHE_MOVE_LIMIT_M` | Metres an owner may move a cache once it has a find, measured from where each coordinate stood at its first find: the cache's own coordinates and each stage's. Before the first find a cache moves freely; a living cache follows its station and is exempt. A larger move is refused, and the owner archives the cache and hides a new one; the sysop corrects any coordinate with `POST /api/admin/caches/<id>/place`. `0` keeps a found cache where it was found · *[Instance setting](#instance-settings)* | `100` |
| `FED_CORROBORATION_QUORUM` | Distinct corroborating identities (registry operator, else signing key) required to promote a find to Tier A | `2` |
| `DOH_URL` | Validating DNS-over-HTTPS resolver (JSON API) for 44net peer onboarding and the DNSSEC proof of `ampr.org` callsign verification. It must validate DNSSEC and return the AD flag | Cloudflare |
| `AMPR_DNS_RESOLVERS` | Comma-separated DNS-over-HTTPS resolvers (JSON API, `?name=&type=` with `accept: application/dns-json` — the `/resolve` and `/dns-query` dialects both work) that must agree on an `ampr.org` verification record DNSSEC does not validate: at least 2 must answer, and every one that answers must return the same TXT set. Name resolvers run by different operators — see [Callsign verification](../run/day-to-day/callsign-verification.md) | `https://cloudflare-dns.com/dns-query`, `https://dns.google/resolve`, `https://dns.quad9.net:5053/dns-query` |
| `AMPR_REQUIRE_DNSSEC` | `1`: `ampr.org` callsign verification accepts only a DNSSEC-validated answer, never resolver agreement. While ampr.org is unsigned (as checked on 2026-09-30), that method then always refuses | off |
| `LOTW_CA_PEM` | PEM certificate(s) of the ARRL Logbook of The World CA(s) trusted for LoTW callsign-certificate verification. Several blocks may be concatenated; a literal `\n` counts as a line break, so the PEM fits a one-line `.env` value. No ARRL certificate ships with the gateway — see [LoTW callsign certificates](../run/day-to-day/callsign-verification.md#lotw-callsign-certificates). Unset ⇒ the LoTW method is off | — |
| `FED_ENDPOINTS` | This instance's typed transport endpoints (JSON array of `{transport,address,priority}`), published as `addresses` in both the descriptor and the registry self-entry | — |
| `FED_AUTO_PROMOTE` | Confirmed-corroboration count to auto-promote an unvetted peer (`0` = off) | `0` |
| `FED_CORROBORATION_SECRET` | If set, `/federation/corroborate` also requires `x-fed-secret`; an asker sends it only to trusted `https` peers. Questions are signed either way; the secret narrows who is answered to the peers you gave it, which `FED_CORROBORATION_REQUIRE_KNOWN` (any known key, `unvetted` peers included) does not | — |
| `FED_CORROBORATION_REQUIRE_KNOWN` | `1`: answer corroboration questions only from known, non-blocked peers (verified by their key) | off |
| `FED_REVEAL_IGATE` | Include the exact IGate in corroboration answers, and accept it in answers received (both peers opt in) | off |
| `RETENTION` | How long the nightly job keeps the diagnostic and telemetry tables, as JSON naming only what you change, e.g. `{"packetsHours":6,"sensorDays":90}`. Keys: `packetsHours` (Shack raw-packet ring), `messagesDays` (the message log and MeshCom group messages), `sensorDays` (weather/telemetry), `portStatsDays`, `alertsDays` (seen watch alerts), `mheardDays` (node MHeard). A missing, non-numeric or non-positive value keeps the default · *[Instance setting](#instance-settings)* | `24` h / `7` / `30` / `7` / `30` / `7` d |
| `MODERATION_RETENTION_DAYS` | Days the nightly job keeps a resolved report (counted from its resolution) and a moderation log row. Open reports stay until resolved, and the log rows of a suspension in force stay while it holds · *[Instance setting](#instance-settings)* | `730` |
| `MESHCOM_META_MIN_S` | Seconds between rewrites of a MeshCom node's or link's row for the map when nothing shown changed (a new device, firmware, battery step, way of hearing, receiver or signal quality is written at once) | `300` |
| `MESHCOM_NODE_TTL_DAYS` / `MESHCOM_LINK_TTL_HOURS` | MeshCom nodes and links not heard for this long are pruned nightly · *[Instance setting](#instance-settings)* | `7` d / `48` h |
| `POS_MIN_MOVE_M` | Metres a station must move since its last stored fix before the next fix is stored. Every fix of a protected station is stored regardless: a call an account holds or has verified (any SSID), a registered station, a call with a find open (a find logged or radio command sent in the verification window, or a radio command pending), the station of a living cache — and so is every fix heard directly on RF (a TNC or MeshCom port). A fix that is not stored still reaches the live map, watch alerts and rendezvous. `0` stores every fix | `25` |
| `POS_MIN_INTERVAL_S` | Seconds after a station's last stored fix at which its next fix is stored even if it has not moved. The station list and the TAK/CoT feed allow for it, since a stationary station's last-heard time refreshes once per interval. `0` stores every fix | `600` |
<!-- /config-table -->

## Gateway — federation

<!-- config-table:gateway-federation -->
| Variable | Purpose | Default |
|---|---|---|
| `FED_PRIVATE_KEY` | Ed25519 signing key (base64 JSON) — if set, feeds are signed | — |
| `FED_KEY_HISTORY` / `FED_ROTATIONS` | Previous keys (each with an `until`) + signed rotations for key rollover | — |
| `FED_ROTATION_GRACE_DAYS` | Days a rotated-away key keeps verifying when its history entry names no `until`; also the grace `rotatekey.mjs` writes | 7 |
| `FED_REGISTRY` / `FED_REGISTRY_KEY` | Signed instance registry + the pinned authority key that verifies it (required whenever a registry is configured) | — |
| `FED_REGISTRY_DNS` | Alternative registry source: a DNS `TXT` record name whose `url=` locates the document; verified under `FED_REGISTRY_KEY` (without it the server refuses to start) | — |
| `FED_OPERATOR` | Operator label, self-published in `/.well-known` beside the service call (`SERVICE_CALL`) | — |
| `FED_PEERS` | Comma-separated peer base URLs to sync from. An entry starts `unvetted`. `<url>#<fingerprint>` pins the peer's key fingerprint (16 hex digits, from its sysop or `node tools/fedkey/fingerprint.mjs`): a peer whose key matches starts `trusted`, one whose key does not is refused. An `http://<name or address>[:port]` entry is a HAMNET peer, dialled like a `hamnet` endpoint with a 2-second timeout, unless its address is loopback, private or CGNAT (a LAN peer) ([HAMNET peers in FED_PEERS](../run/federation/index.md#hamnet-peers-in-fed_peers)) | — |
| `FED_SYNC_REGION` | `S,W,N,E` in decimal degrees: pull only the caches inside this box from peers that filter by region (`sync-cache-bbox`); deletes are never filtered. Changing it reads the caches feed again from the start | whole feed |
| `FED_RESERVE` | Which records mirrored from other instances this instance passes on to its peers, each as its home instance signed it: `trusted` the records of instances trusted here, `all` those of every instance not blocked here, `off` none. A peer verifies each record against its home's key and applies its own trust in that home. A change applies at the peers' next pull. A Pocket station that carries records sets `all` ([Carry records between instances](../run/pocket/carry-records.md)). Also an instance setting ([Hubs, relays and the registry](../run/federation/hubs-and-relays.md#a-hub-passes-its-spokes-records-on)) · *[Instance setting](#instance-settings)* | `trusted` |
| `FED_DISCOVER` | Read each trusted peer's list of the instances it trusts (peer exchange), at most hourly, and list them in Instance admin → Federation → **Discovered**: switched off, unvetted and never pulled until you follow one (at most 200; a listing expires 14 days after no trusted peer names it). `0` stops it ([Discovery](../run/federation/index.md#discovery)) | on |
| `FED_PEER_EXCHANGE` | Serve `/federation/exchange`: the instances this one trusts, each with its key fingerprint and its non-LAN addresses. Never a blocked or unvetted one. `0` stops it. Also an instance setting ([Discovery](../run/federation/index.md#discovery)) · *[Instance setting](#instance-settings)* | on |
| `FED_MDNS` | mDNS on the local network (Node and Bun server): `listen` finds instances announcing `_aprscaching._tcp` and lists them under **Discovered**, marked *on this network*; `announce` also announces this one (its instance id, key fingerprint and port). It runs under Node and Bun alike ([Field discovery on a LAN](../run/federation/index.md#field-discovery-on-a-lan)) | `off`; `listen` on Pocket and the Desktop app |
| `FED_ALLOW_PRIVATE` | `1`: federation may fetch private and loopback addresses (Node/Bun; configured `FED_PEERS`/`FED_HUB_URL` are always allowed) | off |
| `FED_SUBMIT_SECRET` | **Hub:** enables `POST /federation/submit`. **Spoke:** the push secret. Records are signed either way; the secret decides who may register a new spoke's key on the hub | — |
| `FED_SUBMIT_INSTANCES` | Hub allowlist of submitter instances | any non-self |
| `FED_HUB_URL` | Spoke: a reachable hub to push signed records to. Each feed resumes where the hub's marks say it stands; after a network failure the spoke probes the hub (30 s backing off to 10 min) and pushes as soon as it answers | — |
| `FED_SPOKE_STALE_HOURS` | Hub: hours without a submission before Instance admin shows a spoke as stale | 24 |
| `FED_RELAY_SECRET` | Enables the rendezvous relay. Gates a script's enqueueing and results (the requester side, which carries no signature); an instance forwarding a corroboration question to one of this hub's push spokes is let in by its own signed question instead, and spokes lease and answer by signing with their own key. **Spoke:** any value turns collecting on | — |
| `FED_BBS` | Experimental. `1`: federation records travel as FBB personal messages to the forwarding partners marked for federation, and records arriving that way from those partners are applied. Off, nothing is queued for FBB and such messages are dropped. See [Federation over FBB](../run/federation/fbb.md) | off |
<!-- /config-table -->

## Gateway — read API, spots, email/push

<!-- config-table:gateway-api -->
| Variable | Purpose | Default |
|---|---|---|
| `API_RATE_WINDOW_SEC` / `API_RATE_ANON` / `API_RATE_KEYED` | Public read-API rate limits · *[Instance setting](#instance-settings)* | `60` / `60` / `600` |
| `API_KEYS_PER_ACCOUNT` | Read-API keys one account may hold at once; `0` lets nobody create one · *[Instance setting](#instance-settings)* | `5` |
| `SPOTS_ENABLED` | Enable outbound activity-spot polling · *[Instance setting](#instance-settings)* | off |
| `SPOTS_SOURCES` / `SPOTS_TTL_SEC` | Spot source allowlist (`pota`, `sota`, `gma`, `pskreporter`, `dxcluster`, `rbn`), and seconds between upstream polls (never below a source's own floor) · *[Instance setting](#instance-settings)* | all / `120` |
| `SPOTS_USER_AGENT` | The User-Agent sent to spot upstreams | names aprscaching |
| `SPOTS_RECEPTION_URLS` | Endpoints of the reception networks, which have no built-in feed: JSON `{"pskreporter":"…","dxcluster":"…","rbn":"…"}`. A network without an endpoint is not polled. POTA and SOTA use their public APIs | — |
| `GMA_API_KEY` | API key from GMA (gma.rocks), sent with each GMA spot poll. GMA's spot API answers only with a key, so without one GMA spots are off and the instance sends GMA no request | — |
| `EMAIL_FROM` | Sender address of sign-in links, address confirmations and the watch-alert digest, e.g. `aprscaching <noreply@aprs.example.net>`. Mail goes out over SMTP when `SMTP_HOST` is set, else over the Resend API when `EMAIL_API_KEY` is set. Without `EMAIL_FROM` and one of the two, no mail is sent: members sign in with passkeys, or off-grid with the operator's link | — |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | The SMTP server that sends the mail, its port, and how the connection is secured: `starttls` (upgrade a plain connection, refused when the server cannot), `tls` (TLS from the first byte) or `none` (in the clear, only for a relay on the same box or a trusted LAN). Set, SMTP is used even when `EMAIL_API_KEY` is set too | — / `587` / `tls` on port 465, else `starttls` |
| `SMTP_USER` / `SMTP_PASS` | The SMTP login, often the full sender address, and its password. Without `SMTP_USER` the instance sends without logging in | — |
| `EMAIL_API_KEY` | API key of the Resend email API, used when `SMTP_HOST` is unset | — |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | Web-push keys (absent ⇒ push off) | — |
| `VAPID_SUBJECT` | The contact a push service sees in each push request (RFC 8292): a `mailto:` or `https:` URI | `mailto:` + `OPERATOR_EMAIL`; else `https://` + the instance's host |
| `OKAPI_BASE` / `OKAPI_KEY` | OpenCaching import node + consumer key | — |
| `IMPORT_ALLOW` | Import sources whose terms need the provider's permission, comma-separated: `wwff`, `iota`, `gcau`. Name one only once that provider has granted this instance its use; an import of an unnamed one is refused with the permission it needs · *[Instance setting](#instance-settings)* | none |
| `BASEMAP_STYLE` | Basemap of the embeddable map widget (`/embed`): a MapLibre style URL, or `offline` for the self-contained grid, which loads nothing from outside the instance. The widget's content-security policy lets it fetch only from this gateway and the style's origin. A value that is neither `offline` nor an http(s) URL counts as `offline`. The web app's own basemap is the build-time `VITE_BASEMAP` / `VITE_BASEMAP_STYLE` | OpenFreeMap `liberty` |
| `BASEMAP_HOSTS` | Extra origins the `BASEMAP_STYLE` style loads tiles, glyphs or sprites from, comma-separated (`https://tiles.example.net,https://fonts.example.net`), for a style that spreads them over several hosts | — |
| `SUPPORT_LINKS` | Donation links surfaced on `/support` (recognition only), as a JSON array in display order: `[{"label":"Liberapay","url":"https://liberapay.com/…"}]`. Entries need a label and an http(s) URL · *[Instance setting](#instance-settings)* | — |
<!-- /config-table -->

## Licence-register import

Read by `tools/licence/import.mjs` on the operator's machine, not by the gateway. See
[Licence registers](licence-sources.md).

<!-- config-table:licence -->
| Variable | Purpose | Default |
|---|---|---|
| `LICENCE_SOURCES` | Registers to import when no `--source` is given, comma-separated: `fcc`, `ised`, `acma`, `at`, `de` (or `all`) | — |
| `BASE` | Gateway to import into | `http://127.0.0.1:8787` |
| `OPERATOR_SECRET` | The gateway's operator secret; authorises the import (an import rewrites instance-wide data) | — |
<!-- /config-table -->

## Ingest box

Core forwarding and the APRS-IS feed are always available; every RF transport below is opt-in and activates
only when its variable is present.

**Core / APRS-IS feed**

<!-- config-table:ingest-core -->
| Variable | Purpose | Default |
|---|---|---|
| `INGEST_URL` | Gateway ingest endpoint to POST batches to | `http://127.0.0.1:8787/ingest` |
| `INGEST_SECRET` | Sent as `x-ingest-secret`. The only gateway secret an ingest box holds — never give it `OPERATOR_SECRET` or `SESSION_SECRET` | `change-me` |
| `BOX_ID` / `BOX_KEY` | An enrolled box's id and private Ed25519 key (PKCS#8, base64url), both written by enrollment with a one-time code from Instance admin (`apps/ingest/src/enroll.ts`). With them the box signs every gateway request with its own key and needs no `INGEST_SECRET`; revoking the box in Instance admin cuts off that box alone. `BOX_ID` also names the box for remote control (below) | — |
| `BATCH_MS` | Batch flush interval | `1500` (`2000` in the Docker stack) |
| `INGEST_SPOOL_MAX` | Undelivered-packet spool bound (drop-oldest) during a gateway outage | `5000` |
| `APRSIS_HOST` / `APRSIS_PORT` | APRS-IS server | `rotate.aprs2.net` / `14580` |
| `APRSIS_CALLSIGN` / `APRSIS_PASSCODE` / `APRSIS_FILTER` | IS login + server-side filter | `N0CALL` / `-1` / `r/47.07/15.42/300` |
<!-- /config-table -->

**RF transports** — full details and semantics in [RF ingest & transports](../run/radios/rf-ingest.md).

<!-- config-table:ingest-transports -->
| Subsystem | Variables |
|---|---|
| KISS TNC (gates digi/node/BBS/IGate) | `KISS_TNC_HOST`, `KISS_TNC_PORT` (`8001`) |
| AGWPE | `AGWPE_HOST`, `AGWPE_PORT` (`8000`), `AGWPE_RADIO_PORT` (`0`) |
| WA8DED hostmode | `HOSTMODE_HOST`, `HOSTMODE_PORT` (`3694`), `HOSTMODE_MYCALL`, `HOSTMODE_RADIO_PORT` |
| Soundcard port (1200-baud AFSK in the box; carries digi/node/BBS/IGate without a TNC) | `SOUNDCARD_DEVICE` (ALSA capture device; enables the port), `SOUNDCARD_PLAYBACK` (default: the capture device), `SOUNDCARD_RATE` (`48000` or `44100`); transmit: `SOUNDCARD_TX` (`1` allows it; it also needs every station call control-verified at the gateway), `SOUNDCARD_CALL` (default `BOX_CALL`, then `IGATE_CALL`, `DIGI_CALL`), `SOUNDCARD_PTT` (`none`; `serial:<dev>[:<line>]` (line `rts`, `dtr`, `-rts`, `-dtr`), `cat:<dev>:<rig>[:baud[:civ]]` (rig `kenwood`, `icom`, `yaesu-bin`), `rigctld[:host[:port]]`, `cm108[:<hidraw>[:gpio]]`, `gpio:<chip>:<line>`), `SOUNDCARD_PTT_MAX_MS` (`10000`, the PTT watchdog), `SOUNDCARD_TXDELAY_MS` (`300`), `SOUNDCARD_TXTAIL_MS` (`50`), `SOUNDCARD_PERSIST` (`63`), `SOUNDCARD_SLOTTIME_MS` (`100`), `SOUNDCARD_TX_LEVEL` (`0.5`); `SOUNDCARD_PORTS` (JSON array of further ports) — [Soundcard port](../run/radios/soundcard.md) |
| Meshtastic (licensed nodes only) | `MESHTASTIC_HOST`, `MESHTASTIC_PORT` (`4403`) — the node's TCP API; `MESHTASTIC_MQTT_URL` (`mqtt://` or `mqtts://`, credentials in the URL), `MESHTASTIC_MQTT_TOPIC` (`msh/#`) — a broker's protobuf feed |
| MeshCom | `MESHCOM_NODE` (node address(es), each optionally `=CALL`; enables the listener), `MESHCOM_PORT` (`1799`), `MESHCOM_BIND` (default: this host's address on the node's subnet), `MESHCOM_FANOUT` (`host:port` list), `MESHCOM_RATE` (`20`/s per node), `MESHCOM_STALE_MIN` (`30`); transmit: `MESHCOM_TX` (`1` lets the box answer radio commands through its nodes), `MESHCOM_TX_CALL` (the operator's call, which must match the node's; default `BOX_CALL`, then `IGATE_CALL`, `DIGI_CALL`), `MESHCOM_TX_AUDIT` (JSON-lines audit file), `MESHCOM_TX_BURST` (`3`) / `MESHCOM_TX_REFILL_SEC` (`60`), `MESHCOM_KISS_PASS` (the first node's KISS password: with it, answers and Mailbox messages go out from the service call through the node's KISS port, which needs the node's `--kiss auth on`) / `MESHCOM_KISS_PORT` (`8001`) — [transmit pacing](../run/compliance/on-air-stations.md#transmit-pacing) |
| AXUDP | `AXUDP_PORT`, `AXUDP_BIND`, `AXUDP_PEERS` |
| AXIP | `AXIP_ENABLE`, `AXIP_PEERS`, `AXIP_BIND` |
| Digipeater | `DIGI_CALL`, `DIGI_ALIASES` (`WIDE1,WIDE2`), `DIGI_CONNECTED`, `DIGI_VISCOUS_MS` (the connected-mode digipeater's delay before it repeats a frame, so a better-placed digi goes first) |
| NET/ROM node | `NETROM_CALL`, `NETROM_ALIAS`, `NETROM_BROADCAST_MS` (`3600000`, one hour; at least 5 minutes), `NETROM_PATH_QUALITY` (`192`, 0–255), `NETROM_INP3` (`1` also speaks INP3 alongside NODES), `NODE_PERSONALITY` (`netrom` \| `flexnet` \| `tnn` \| `baycom` command surface) |
| BBS (inbound + forwarding) | `BBS_NODE_CALL`, `BBS_FORWARD`, `BBS_FORWARD_CALL`, `BBS_FORWARD_POLL_MS` (`60000`), `BBS_FORWARD_SID`, `BBS_FORWARD_COMPRESS` (`1` offers LZHUF-B1 compressed forwarding; engages only when the partner's SID also advertises `B`), `BBS_FORWARD_BURST` (`4`) / `BBS_FORWARD_REFILL_SEC` (`300`) — sessions, see [transmit pacing](../run/compliance/on-air-stations.md#transmit-pacing) |
| Federation over packet circuits | `FED_LINK_SERVE` (`1` answers pull-sync on `FED_LINK_CALL` and as the node's FED command), `FED_LINK_PULL` (`1` pulls from peers that publish an `ax25` or `netrom` endpoint), `FED_LINK_CALL` (the call-SSID it answers and dials as), `FED_LINK_PULL_MS` (`3600000`, one hour; at least one minute; one session per interval), `FED_LINK_PAGES` (`20` pages per session), `FED_LINK_NODE` (the node a `netrom` endpoint is entered through) — see [Packet circuit](../run/federation/transports.md#packet-circuit) |
| IGate | `IGATE_CALL`, `IGATE_PASS` (both enable the RX-IGate), `IGATE_TX` (`1` also passes APRS-IS messages to RF; off by default), `IGATE_FILTER`, `IGATE_LOCAL_TTL`, `IGATE_TX_PATH` (blank = direct), `IGATE_TX_BURST` (`6`) / `IGATE_TX_REFILL_SEC` (`10`) — [transmit pacing](../run/compliance/on-air-stations.md#transmit-pacing) |
| Receiving site (Tier A) | `RF_SITE_CALL` — names the box as the receiving site of frames its local TNCs (KISS, AGWPE, WA8DED host mode) hear directly (default `IGATE_CALL`); the gateway's sysop trusts it in Instance admin (or presets it in `FIRST_PARTY_SITES`). Set it only for a TNC you operate — leave it unset when the TNC host is someone else's station |
| Remote control (Shack → Remote box) | `BOX_ID` (the box's name; the box pairs with an account by the one-time code it prints at start), `BOX_TX` (`1` allows remote transmit), `BOX_CALL` (default `IGATE_CALL`, then `DIGI_CALL`), `BOX_TX_PATH` (`WIDE1-1,WIDE2-1`), `BOX_CMD_MAX_AGE` (`900` s), `BOX_POLL_MS` (`5000`), `BOX_TX_BURST` (`3`) / `BOX_TX_REFILL_SEC` (`60`) — [transmit pacing](../run/compliance/on-air-stations.md#transmit-pacing) |
| APRS-IS uplink (answers, announces, weather) | `APRSIS_SERVICE_CALL`, `APRSIS_SERVICE_PASS`, `CWOP_HOST`, `CWOP_PORT` (`14580`). Without them, a box whose `APRSIS_CALLSIGN` shares the gateway's service-call base call and has an `APRSIS_PASSCODE` logs in as the service call: the sysop's own box publishes the outbox with no further setting, and any other box publishes nothing. Answers from the service call go out as plain APRS messages, which IGates gate to RF; announced finds go out as third-party traffic |
<!-- /config-table -->

Where the box reads these: the process environment first, then `.env` in `apps/ingest/`, then `.env` at the
top of the checkout. Under Docker, `deploy/.env` reaches the container through the compose file; under
systemd, through `EnvironmentFile`. Put comments on their own lines — systemd does not strip a trailing
`# comment` from a value.

## Desktop app

The single-file desktop build (`deploy/desktop/`) runs the gateway and the web app together. It generates its
`INGEST_SECRET`, `OPERATOR_SECRET` and `SESSION_SECRET` on first run into the data directory unless the
environment sets them.

<!-- config-table:desktop -->
| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Local port for the app | `8787` |
| `HOST` | Address to listen on; `0.0.0.0` or a LAN address serves the local network | `127.0.0.1` |
| `DATA_DIR` | Where the database and media live | `%APPDATA%\aprscaching` · `~/Library/Application Support/aprscaching` · `$XDG_DATA_HOME/aprscaching` (`~/.local/share/aprscaching`) |
| `WEB_DIST` / `MIGRATIONS_DIR` | Serve the web app / apply migrations from disk instead of the copies built into the binary | built in |
<!-- /config-table -->

## Web build

Build-time variables (`import.meta.env.VITE_*`) baked into `apps/web`.

<!-- config-table:web -->
| Variable | Purpose | Default |
|---|---|---|
| `VITE_API_BASE` | Gateway base URL. Set it whenever the API lives on another host than the web app. Without it the app talks to its own origin — right wherever one host serves both the SPA and the API, the dev server included (it proxies the gateway's paths to the local gateway) — never to localhost | same origin |
| `VITE_APP_URL` | The instance's public URL. Its origin makes the landing page's canonical link and Open Graph URLs absolute; without it the build leaves the canonical link and `og:url` out and serves `og:image` from its own path | (unset) |
| `VITE_BASEMAP` | `offline` uses the self-contained graticule; else the online vector basemap | online |
| `VITE_BASEMAP_STYLE` | MapLibre style URL for the vector basemap (self-hosted tiles, commercial provider) | OpenFreeMap `liberty` |
| `VITE_SAT_TILES` / `VITE_SAT_ATTRIBUTION` | Satellite raster layer URL + attribution | EOxCloudless 2016 layer (EOX; free for non-commercial use) |
<!-- /config-table -->

## Deploy scripts

Read by the scripts under `deploy/`, not by the gateway or the ingest box. `deploy/aprscaching` reads them from
the shape's `.env`; `deploy/backup.sh` reads only its environment, so pass them on its cron line (its `DB_PATH`
defaults to `/opt/aprscaching/data/aprscaching.db`).

<!-- config-table:deploy -->
| Variable | Read by | Purpose | Default |
|---|---|---|---|
| `DOMAIN` | `deploy/Caddyfile` | What Caddy serves: a hostname gets automatic Let's Encrypt TLS, `:80` serves plain HTTP (local or off-grid). `deploy/setup.sh` writes it | — |
| `TUNNEL_TOKEN` | `deploy/compose.home.yml` | The Cloudflare Tunnel token for a named tunnel created in the Cloudflare dashboard | — |
| `BACKUP_DIR` | `deploy/backup.sh` | Back up to this local or mounted directory — use a mount that is not the database's disk | — |
| `OCI_BUCKET` | `deploy/backup.sh`, `deploy/aprscaching backup` | Back up to this OCI Object Storage bucket (needs the `oci` CLI configured): `backup.sh` snapshots under `db/`, `deploy/aprscaching backup` archives under `archives/` | — |
| `BACKUP_BUCKET` / `R2_ENDPOINT` | `deploy/backup.sh` | Back up to this S3-compatible bucket (Cloudflare R2, AWS S3) at this endpoint URL; both are required, and the `aws` CLI must be configured | — |
| `BACKUP_RETENTION_DAYS` | `deploy/backup.sh` | Snapshots in `BACKUP_DIR` older than this many days are deleted; with `BACKUP_PRUNE_BUCKET=1`, bucket snapshots too | `30` |
| `BACKUP_PRUNE_BUCKET` | `deploy/backup.sh` | `1` makes the script delete bucket snapshots older than `BACKUP_RETENTION_DAYS`, for buckets without a lifecycle rule; the bucket key then needs delete permission. Unset, bucket destinations are append-only — expire them with a lifecycle rule ([Backups](../run/day-to-day/backups.md#what-to-back-up)) | off |
| `BACKUP_KEEP` | `deploy/aprscaching backup` | The newest this many archives stay in the local destination (`--dest`, `BACKUP_DIR`, else `deploy/backups/`); each backup deletes the older ones, whether or not it was also uploaded | `14` |
| `CF_API_TOKEN` / `CF_ZONE_ID` | `deploy/cloudflare/cache-rules.sh` | Cloudflare API token and zone for the CDN cache rules when Self-host runs behind Cloudflare | required by that script |
<!-- /config-table -->

`deploy/backup.sh` uses the first destination that is set, in the order above. The Pocket extras read
these from `~/.aprscaching/.env`:

<!-- config-table:pocket -->
| Variable | Purpose | Default |
|---|---|---|
| `POCKET_ALERTS` | `1`: vibrate on a new direct message to your call (MeshCom or APRS) | off |
| `POCKET_ALERTS_SPEAK` | `1`: also say who the message is from | off |
| `POCKET_ALERTS_SPEAK_BODY` | `1`: speak message bodies too — they may be private, and a phone speaks aloud | off |
| `POCKET_BATTERY_LOW` | Below this battery percentage, on battery, the station switches to a saver profile (APRS-IS narrowed to your own call, shorter raw-packet retention); `0` turns it off | `20` |
| `POCKET_SYNC_MOBILE` | `1`: `extras/sync-now.sh` may sync over mobile data, not only Wi-Fi | off |
<!-- /config-table -->

## Next

- [Secrets and credentials](secrets.md): the settings to keep secret, and how to rotate them.
- [Command-line tools](cli.md): the operator tools beside the settings.
