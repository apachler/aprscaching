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
- [ ] **CoT streaming feed** *(P3 · S)* — an SSE/long-poll TAK feed alongside the bbox snapshot, so
  ATAK/WinTAK get push updates.
- [ ] **Live-room region sharding** *(P3 · M)* — shard the live WebSocket room by geohash so fan-out scales
  past a single global room.
- [ ] **One-click POI overlay** *(P3 · S)* — a map-side toggle that live-queries a curated OSM/Wikidata set
  (peaks, castles, lighthouses) for the current viewport as a switchable layer, respecting each source's
  attribution.

## Engineering-quality follow-ups (opportunistic, not defects)

- [x] **Type-aware ESLint** — a separate, slower `lint:types` job now runs `@typescript-eslint`
  type-checked rules over `workers/` + `packages/` (the trust-critical surface), gating the real
  promise/assertion bug-catchers while the by-design `any` boundaries stay off. See `eslint.config.types.mjs`.
- [x] **Burn down the lint warnings** — the fast `pnpm lint` is at **0 warnings**; keep it there (clear
  opportunistically when touching neighbouring code, never let the count grow).
- [ ] **Tighten the type-aware warnings** *(P3 · M)* — `lint:types` still reports softer warnings
  (`no-base-to-string`, `restrict-template-expressions`, `no-unnecessary-type-assertion`, …). Promote them
  to errors rule-by-rule as the code is cleaned, the same way the fast config was tightened.

## Deferred by design (reserved seams, opened on demand)

- [ ] **CI depth & deploy topologies** — exercise the `deploy/` topologies 1–4 in CI beyond the current
  tri-runtime conformance (Node / Worker / Bun), and the federation push-to-hub **rendezvous relay's**
  corroboration path. Reserved seams, wired up when there's a concrete need.
