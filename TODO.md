# Deferred / post-1.0

The full status of every capability lives in **`docs/26-v1.0-consolidated-roadmap.md`** — that's the
authoritative record of what's built. This file is the short list of what's *intentionally* left for after
the 1.0 tag, and why.

## Needs hardware or a live partner (can't be validated headlessly)
- **Owned-RF Tier A · 44net PoP · IPIP-Mesh/BGP** — genuine Tier-A corroboration needs a receiver *you*
  operate and attest for. The provenance seam is built and Tier A is designed-for; standing up the RF site,
  the 44net gateway/subnet, and mesh routing is hardware + network-ops, not code. (`docs/22`)
- **FBB LZHUF (B0/B1) compression** — correctness *is* byte-exact compatibility with FBB's fixed Huffman
  tables, which no round-trip test can prove; it must be validated against a real FBB partner. ASCII FBB
  forwarding is fully interoperable without it. (`docs/29`)
- **Live-radio behaviour** — the pure codecs (KISS/AX.25, Meshtastic protobuf, CW/PSK31, CAT/`rigctld`,
  AXUDP/AXIP) are unit-tested; lighting them up on real hardware (a TNC, a rig, a raw-IP socket, off-air
  weak signals) is a field/deploy step by nature.

## Native packaging
- **Capacitor mobile shell** — reuse the web app in a native iOS/Android wrapper for USB-serial / BLE-KISS
  and background operation. A build/sign/store pipeline, not a headless code core. (`docs/21`)

## Future ideas (not yet built, still wanted)
- **Retro read-only access** — small Node daemons (raw TCP/TLS, not Workers) exposing caches-near / station
  info / leaderboard over **Finger**, **Gopher**, and **Gemini**. Fits the "it's a network" ham-retro aesthetic.
- **Ham-radio QSO logbook** — a worked-stations log (band/mode/freq/RST/grid) with **ADIF** import/export and
  optional LoTW/eQSL/QRZ sync, distinct from the cache logbook.
- **CoT streaming feed** — an SSE/long-poll TAK feed alongside the bbox snapshot, so ATAK/WinTAK get push
  updates.
- **Live-room region sharding** — shard the live WebSocket room by geohash so fan-out scales past a single
  global room.
- **One-click POI overlay** — a map-side toggle that live-queries a curated OSM/Wikidata set (peaks, castles,
  lighthouses) for the current viewport as a switchable layer, respecting each source's attribution.

## Deferred by design (see the roadmap for the rest)
- **CI depth**, additional deployment-topology exercises, and the federation push-to-hub *rendezvous relay's*
  corroboration path are tracked in `docs/26` / `docs/15` — reserved seams, opened when there's a concrete need.
