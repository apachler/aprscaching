# Deferred / post-1.0

What actually **shipped** is in [`CHANGELOG.md`](CHANGELOG.md) and the product manual under
[`docs/`](docs/). This file is the short, honest list of what is *intentionally* left for after the
1.0 tag — and **why** each piece waits. It's a live checklist: boxes get ticked as items land, and
nothing here is a known defect (the pre-launch hardening pass closed those).

Each item carries a rough **priority · size** where useful — `P1`–`P3` (higher = sooner) and
`S`/`M`/`L` (effort). Grouped by *why* it's deferred, not by area.

## Needs hardware or a live partner (can't be validated headlessly)

These are blocked on physical radio, a real peer, or a network no CI runner has — not on code.

- [ ] **Owned-RF Tier A · 44net PoP · IPIP-mesh/BGP** — genuine Tier-A corroboration needs a receiver
  *you* operate and attest for. The provenance seam is built and Tier A is designed-for; standing up the
  RF site, the 44net gateway/subnet, and mesh routing is hardware + network-ops, not code.
  See [`docs/guides/federation.md`](docs/guides/federation.md) · [`docs/operate/rf-ingest.md`](docs/operate/rf-ingest.md).
- [ ] **FBB LZHUF (B0/B1) compression** — correctness *is* byte-exact compatibility with FBB's fixed
  Huffman tables, which no round-trip test can prove; it must be validated against a real FBB partner.
  ASCII FBB forwarding is fully interoperable without it. See [`docs/operate/packet.md`](docs/operate/packet.md).
- [ ] **Live-radio behaviour** — the pure codecs (KISS/AX.25, Meshtastic protobuf, CW/PSK31, CAT/`rigctld`,
  AXUDP/AXIP) are unit-tested; lighting them up on real hardware (a TNC, a rig, a raw-IP socket, off-air
  weak signals) is a field/deploy step by nature. See [`docs/operate/rf-ingest.md`](docs/operate/rf-ingest.md).

## Native packaging

- [ ] **Capacitor mobile shell** *(P3 · L)* — reuse the web app in a native iOS/Android wrapper for
  USB-serial / BLE-KISS and background operation. A build/sign/store pipeline, not a headless code core.
  See [`docs/operate/deployment.md`](docs/operate/deployment.md).

## Future ideas (not yet built, still wanted)

- [ ] **Retro read-only access** *(P3 · M)* — small Node daemons (raw TCP/TLS, not Workers) exposing
  caches-near / station info / leaderboard over **Finger**, **Gopher**, and **Gemini**. Fits the
  "it's a network" ham-retro aesthetic.
- [ ] **Ham-radio QSO logbook** *(P3 · M)* — a worked-stations log (band/mode/freq/RST/grid) with **ADIF**
  import/export and optional LoTW/eQSL/QRZ sync, distinct from the cache logbook.
- [x] **CoT streaming feed** — `GET /api/cot/stream` is a Server-Sent Events TAK feed alongside the
  `/api/cot` bbox snapshot: it emits the snapshot then pushes station updates, so ATAK/WinTAK get live
  pushes. The runtime shells stream `text/event-stream` bodies (the Node shell pipes rather than buffers).
- [ ] **Live-room region sharding** *(P3 · M)* — shard the live WebSocket room by geohash so fan-out scales
  past a single global room.
- [ ] **One-click POI overlay** *(P3 · S)* — a map-side toggle that live-queries a curated OSM/Wikidata set
  (peaks, castles, lighthouses) for the current viewport as a switchable layer, respecting each source's
  attribution.

## Engineering-quality follow-ups (opportunistic, not defects)

- [x] **Platform overlay state** — the map workbench's "single-overlay" invariant (at most one top-level
  surface open) is modelled as one `useOverlays()` value instead of a boolean-per-panel plus a
  hand-maintained close-everything list, so opening one surface cannot leave another stuck open.

- [x] **Type-aware ESLint** — a separate, slower `lint:types` job now runs `@typescript-eslint`
  type-checked rules over `workers/` + `packages/` (the trust-critical surface), gating the real
  promise/assertion bug-catchers while the by-design `any` boundaries stay off. See `eslint.config.types.mjs`.
- [x] **Burn down the lint warnings** — the fast `pnpm lint` is at **0 warnings**; keep it there (clear
  opportunistically when touching neighbouring code, never let the count grow).
- [ ] **Tighten the type-aware warnings** *(P3 · M)* — promote `lint:types` warnings to errors rule-by-rule
  as the code is cleaned. **Done so far:** `require-await` and `unbound-method` are now **errors** (the
  handful of legitimate exceptions — the Durable Object hibernation handlers must be async; a data
  property named `apply` — carry a documented inline disable); the *identity-collision* subset of
  `no-base-to-string`/`restrict-template-expressions` (arbitrary third-party JSON stringified into an
  id/callsign/externalId in the spot + import parsers) is coerced to scalars (`pickStr`/`str`). **Left:**
  `no-base-to-string` on internal typed DB fields (type-narrowing noise), and `no-unnecessary-type-assertion`
  stays a **warning** — it false-positives on generic `.json()`/`unknown` returns under `projectService`.

## Federation over RF (the wire contracts are in; the bindings land in this order)

The CBOR signed wire format, typed peer endpoints, the two-tier transport seam (sync +
store-and-forward), and ARDC-verified 44net onboarding are built — see
[`docs/reference/federation-wire.md`](docs/reference/federation-wire.md). What rides on them next:

- [x] **Serve/consume CBOR frames on the sync surface** — `GET /federation/sync/<type>` serves signed
  fedwire frames; consumers prefer it via the `sync-cbor` capability (JSON feeds remain as the
  fallback + compatibility surface), and the 2-instance conformance suite asserts the CBOR path.
- [x] **Advertise our own endpoint set** — the `/.well-known/aprscaching` descriptor publishes the
  instance's typed endpoints (`FED_ENDPOINTS` → `addresses`).
- [x] **Endpoint sets in the signed registry** — a registry entry carries the instance's typed
  endpoints (`addresses`), re-validated on load so a malformed address never rides in; the self-entry
  publishes them from `FED_ENDPOINTS`, and the signing tooling documents the field. The registry is a
  tamper-proof directory of who-is-reachable-where (addressing only, never a trust uplift).
- [ ] **Retire the JSON per-record signatures** *(P3 · M)* — once the relay and push-to-hub paths carry
  fedwire frames, the stableStringify signing base goes away and CBOR is the only signed form
  end-to-end.
- [x] **44net onboarding wizard in the admin surface** — the sysop federation panel adds a peer by
  callsign (DNSSEC-validated bindings admit in one click; otherwise the resolved key is shown for an
  explicit trust-on-first-use pin) and emits this instance's own `_aprscaching.<call>.ampr.org` TXT to
  paste into the ARDC portal.
- [ ] **Connected-mode sync binding** *(P2 · L)* — fedwire frames over an AX.25/NET-ROM circuit
  (`apps/ingest` owns the radio; capability HELLO picks the compact tier); an aprscaching service
  advertised on the node.
- [x] **Store-and-forward carrier over FBB forwarding** — complete, including the relay's packet
  leg. `encodeFedBbsBatch`/`decodeFedBbsBatch` pack signed frames into a text-safe `ACSFED` bulletin
  with a content-addressed BID for mesh dedup (`packages/shared`); `POST /federation/bbs/enqueue`
  signs local feed records (tombstones first, same producer as the HTTP sync surface) into one such
  bulletin that the existing forwarding rules/pool/scheduler carry like any other; the
  forward-inbound hook routes an arriving `ACSFED` bulletin through `applyFedBbsBulletin`, which
  verifies each frame against its claimed origin's keys (last-pinned peer key + signed-registry
  binding), applies idempotently by gid, and quarantines unknown or blocked origins — receiving a
  frame lifts no trust and introduces no peer. The rendezvous relay rides the same carrier: `POST
  /federation/relay/<instance>/dispatch` packs a packet-only spoke's queued queries into signed
  `relayQuery` frames, the spoke answers off its receive path with signed `relayAnswer` frames, and
  the hub lands them scoped to the answering instance's own queue — signatures bind both directions,
  so no relay secret ever rides the air.
- [x] **Beacon tier** — one signed frame in one UI datagram (`ACSB1`). `GET /federation/beacon`
  serves the instance's signed presence record (identity + typed endpoints, trimmed to the
  single-frame fit) for the ingest box to transmit; `POST /federation/beacon` feeds a heard datagram
  into the shared trust-gated pipeline — a known origin's peer-announce refreshes its endpoints
  (update-only; a beacon never introduces a peer), tombstones apply by gid, unknown origins are
  quarantined.
- [ ] **Node personalities beyond NET/ROM+BPQ** *(P3 · L)* — FlexNet RTT autorouting, TheNetNode
  command set, BayCom compatibility as selectable node personalities.
- [ ] **Shared compression dictionary** *(P3 · S)* — the `deflateDict1` versioned dictionary for the
  compact/beacon tiers, shipped in `packages/shared`.

## Deferred by design (reserved seams, opened on demand)

- [ ] **CI depth & deploy topologies** — exercise the `deploy/` topologies 1–4 in CI beyond the current
  tri-runtime conformance (Node / Worker / Bun), and the federation push-to-hub **rendezvous relay's**
  corroboration path. Reserved seams, wired up when there's a concrete need.
