# TODO — deferred work

Tracked items intentionally postponed. Each notes *why* and a sketch of *how*.

## Federation hardening
- [ ] **Signed corroboration responses (F3 anti-forgery).**
  Today a peer's `POST /federation/corroborate` answer is trusted because the peer is configured
  (allowlist). A malicious/compromised peer could fabricate a Tier-A by answering `corroborated:true`.
  Fix: have the responder **sign the evidence** with its instance Ed25519 key (and ideally include
  the corroborating IGate's own signature / the raw signed APRS frame). The asker verifies the
  signature against the peer's `/.well-known` public key before upgrading to Tier A, and stores the
  signed evidence in `cache_logs` for audit. Stronger still: require the evidence to reference a
  position the peer also publishes in its (signed) feed, so corroboration is independently checkable.

- [ ] **Network leaderboards over mirrored signed finds.**
  Aggregate `cache_logs` (native) + `remote_finds` (mirrored) into regional/global leaderboards
  (finds, points, SOTA-style). Count **only signed, verified** finds (`signer_key` present + author
  signature valid + tier ≥ B) to resist gaming. Needs: carry `signer_key/author_sig/signed_at` into
  `remote_finds` (add columns + upsert), verify author signatures on mirror (using `remote_keys`),
  a `GET /api/leaderboard?bbox=&period=` endpoint, and a web view. De-dupe a logger across instances
  by callsign.

- [ ] **Gate key registration behind the callsign-control badge.**
  `POST /keys/register` currently records the badge state but accepts any binding (advisory). Once a
  callsign is badge-verified (APRS challenge in `callsign.ts`) or passkey-session-bound, require that
  to register/replace a device key — so a key can only be bound to a callsign by someone proven to
  control it. Until then, mark unverified-callsign keys as low-trust in the keys feed and exclude
  them from leaderboard credit.

## Imports / UX
- [ ] **One-click "POI layer" toggle for OSM + Wikidata.** The `osm` and `wikidata` importers exist
  but require an admin POST with a tag/Q-id + bbox. Add a map-side toggle that, for the current
  viewport, imports (or live-queries) a curated set — peaks (`natural=peak` / Q8502), castles
  (`historic=castle` / Q23413), lighthouses (`man_made=lighthouse` / Q39715) — and renders them as a
  switchable overlay distinct from caches. Decide: persist-as-imported vs. ephemeral live layer;
  respect ODbL attribution (OSM) and rate limits. Let users pick which feature classes to show.

## M5 workbench — follow-ups
- [ ] **APRS messaging (RX is done; add TX).** Inbound text messages + bulletins are decoded and
  stored (`messages`); surface a message/bulletin view and, gated behind TX policy + callsign badge,
  let a station send a message via the announce uplink.
- [ ] **Telemetry parameters + charts.** Telemetry analog channels are decoded but unlabeled —
  capture the `PARM/UNIT/EQNS/BITS` definition messages and render labelled gauges/series.
- [ ] **MIC-E external test vectors.** Current MIC-E tests are spec-anchored (destination→lat,
  info-byte→lon) plus derived course/speed; add a few captured real-world frames as regression
  vectors once an offline corpus is available (egress to live APRS-IS is blocked in CI).
- [ ] **Station track polyline.** `/api/stations/:call` returns the recent track; draw it on the map
  when a station is selected (currently shown as a count).

## M6 interop — follow-ups
- [x] **Live transport connectors** in the ingest box: KISS/TNC over TCP, TAK/CoT *inbound* (UDP),
  and Meshtastic (JSON over TCP) — each forwarding to `/ingest` with its `port`. (Codecs in
  `@aprsweb/aprs`, connectors in `apps/ingest`, opt-in via env.)
- [ ] **Deeper transport paths**: native MQTT + BLE + serial + protobuf for Meshtastic; serial KISS;
  and **APRS-IS / RF TX** (message send + beaconing) gated behind TX policy + the callsign badge.
- [ ] **CoT streaming feed** (SSE/long-poll) in addition to the bbox snapshot, so TAK clients get
  push updates; consider per-client auth + a stable feed UID namespace.
- [ ] **Region sharding** for live rooms (`LIVE_REGION` is a single global room today): shard the
  Durable Object by geohash so fan-out scales, with subscription routing across shards.

## Identity, accounts & data lifecycle (GDPR / DSGVO)
- [ ] **Finish WebAuthn/passkey auth** (`auth.ts` is a scaffold): real register/login ceremonies,
  credential storage, session binding. Registration = claim callsign → passkey; logging stays
  open (unverified accounts still log, flagged).
- [ ] **Callsign-control gating**: the APRS-message challenge (`callsign.ts`) already proves control;
  require a verified+badged callsign to register/replace a device key and to earn leaderboard credit
  (also in the federation-hardening section).
- [ ] **GDPR endpoints**: `GET /api/account/export` (machine-readable copy of everything tied to a
  callsign — account, logs, positions, keys, favorites) and `POST /api/account/delete` (erase /
  anonymise: drop PII, tombstone logs as `withdrawn`, revoke keys, propagate a federation tombstone
  so mirrors purge too). Document a retention policy + a privacy notice; positions TTL already helps.
- [ ] **Account portability across peers** (federation): export a *signed account bundle* (device
  pubkeys + a migration assertion signed by the account key) and import it on the target instance,
  which verifies the signature, claims the callsign, and the old instance issues a `moved` tombstone
  + redirect. Because finds are per-callsign device-signed, history stays attributable post-move.

## M2 remainder
- [ ] **Audio-cache staged unlock.** Store audio/media in R2; stage gating (`cache_stages.unlock =
  audio`) reveals the next stage's coordinates after the audio clue. (Geofencing core is done.)

## M2 geofencing — known follow-ups
- [ ] Only compute geofence prompts for positions whose callsign has an **active WS subscription**
  (avoid a DB query per firehose position at scale).
- [ ] **Debounce prompts**: fire on *entry* into a radius (track last-prompted per callsign+cache),
  not on every position update, to avoid spamming.
- [ ] Geofence against **mirrored** caches too (peer caches), not just native.
