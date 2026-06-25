# RF hardware interfacing — TNCs, soundcard modes, mesh (box + browser-direct)

Status: **Backlog spec.** Consolidates how aprscaching connects to real RF hardware — scattered today
across `docs/01` (Phase 8), `docs/08` (RF modes backlog), and `apps/ingest`. Two complementary paths,
one shared codec layer. Build against `.claude/rules/{ui-ux,css}.md` and the cost rules.

## Architecture: two paths, one codec layer

The frame logic is **pure and already shared** — `@aprsweb/aprs` exports `kissFrames` (deframe),
`kissWrap` (frame), `decodeAx25`, `encodeAx25`, plus `mice`/`compressed`/`tnc2`/`meshtastic`/`cotin`
decoders, all unit-tested and runtime-neutral. Only the **transport** differs between the two paths,
so adding a path is "wire a new byte source/sink into the existing deframer," not new protocol code.

**Path A — the always-on ingest box (server-side, IMPLEMENTED).** `apps/ingest` (Node) is the 24/7 RF
citizen: `KissTnc` (KISS-over-TCP → Direwolf or a networked hardware TNC, `KISS_TNC_HOST`), `CotListener`
(TAK/CoT UDP), `MeshtasticReader` (JSON-over-TCP bridge), plus the **digipeater** (KISS TX) and
bidirectional **IGate** (RF↔APRS-IS). It batches to `POST /ingest`. Native MQTT/BLE/serial + Meshtastic
protobuf are TODO. This path owns continuous, shared, licence-bearing duties (IGate/digi) and serves
**every** client including iOS.

**Path B — browser-direct hardware (PLANNED — `docs/01` Phase 8, "stretch").** The SPA reaches local
hardware itself via **Web Serial / Web Bluetooth / WebUSB / Web Audio**, deframes with the same
`@aprsweb/aprs` code, and feeds the local map (and optionally up to the worker for IGate). No cloud
daemon, no server cost. Chromium-only, HTTPS-only, user-gesture-gated.

```
radio ── [TNC | soundcard | mesh node]
            │
    ┌───────┴───────────────────────────────────┐
    │ Path A: box transport (TCP/UDP socket)      │  always-on · shared · iOS-capable
    │ Path B: browser transport (Serial/BLE/USB/  │  field · Chromium · zero server cost
    │          Audio)                             │
    └───────┬───────────────────────────────────┘
            ▼
   @aprsweb/aprs  (kissFrames · decodeAx25 · mice · tnc2 · meshtastic …)  ← SAME code both paths
```

## Can a user do all RF via the browser? Capability matrix

| Capability | Browser-direct (Path B) | Notes |
|---|---|---|
| KISS TNC over **USB serial** | ✅ Chromium **desktop** (Android emerging) | Web Serial — desktop solid; Android only from Chrome 148 beta (Apr 2026), BT-RFCOMM-first, USB-serial limited ~2026Q2. **No Safari/Firefox/iOS** → companion (`docs/21`) |
| KISS TNC over **Bluetooth LE** | ✅ Chromium desktop/Android | Web Bluetooth + **BLE-KISS API** (below); **not iOS Safari** (iOS BLE = the Capacitor companion, `docs/21`) |
| Meshtastic / LoRa node | ✅ | Web Serial / BLE (Meshtastic's own web client already does this) |
| **Soundcard AFSK — no TNC at all** | ⚠️ stretch | Web Audio Bell-202 modem (proven by `modem.js`/`afsk.js`) |
| CAT control + PTT of a transceiver | ✅ | serial RTS / CAT command over Web Serial (DigiRig-class CDC) |
| 24/7 IGate / digipeater | ❌ → Path A | a browser tab is not an always-on RF service |
| **iOS / iPadOS browser RF** | ❌ → Path A or native | Safari has no Web Serial/USB/Bluetooth |
| Off-grid / no-internet emergency ops | ❌ out of scope | it's a web app (APRStac's EMCOMM core is deliberately excluded) |

**Bottom line:** on Chromium desktop/Android a user can plug or pair a TNC — or use just an audio cable —
and do RX/TX from the page; on iOS/Safari/Firefox they go through the ingest box (or a future native/PWA
shell). Not "all RF in every browser," but "most RF in Chromium, everything-shared via the box."

## Browser API + transport layer (Path B)
A small `transports/` layer in `apps/web`, each implementing a common `{open, read→Uint8Array, write,
close}` byte-stream contract that feeds `kissFrames`/`decodeAx25`:
- **Web Serial** (`navigator.serial`) — USB/serial KISS TNCs and CAT/PTT. Chromium 89+, HTTPS, gesture.
- **Web Bluetooth** (`navigator.bluetooth`) — implement the **BLE-KISS API** (service + RX/TX
  characteristics) so Mobilinkd/Kenwood/aprs.fi-compatible TNCs interoperate out of the box.
- **WebUSB** — fallback for devices that expose a raw USB interface rather than a serial CDC.
- **Web Audio** (`AudioContext` + `getUserMedia`) — in-browser **Bell-202 1200-baud AFSK** modem
  (modulate to speaker, demodulate from mic/line-in) so a bare HT + audio cable needs **no TNC**. PTT
  via VOX or a Web Serial RTS line. This is the highest-value stretch (cheapest entry, zero extra hw).

Proven prior art: `SQ2CPA/aprs-tnc-web` (browser KISS TNC), Meshtastic Web (Web Serial), `dolske/modem.js`
& `andreasgal/afsk.js` (Web Audio AFSK).

## Supported / recommended hardware

| Device | Class | Browser path | Why support it |
|---|---|---|---|
| **DigiRig Mobile** | USB soundcard + CAT/PTT | Web Serial (CAT/PTT) + Web Audio (AFSK) | cheapest entry: any radio, no TNC; Icom/Yaesu/Baofeng/Xiegu |
| **NinoTNC** | USB hardware KISS TNC | Web Serial | **FX.25 + IL2P** FEC → higher decode yield → stronger Tier-A |
| **Mobilinkd TNC4** | BLE / USB-C KISS TNC | Web Bluetooth (BLE-KISS) / Web Serial | battery, mobile, M17; the reference BLE-KISS device |
| **Kenwood TH-D74 / TH-D75** | HT w/ built-in KISS TNC | Web Serial (D75 USB-C) / BLE | a data radio + TNC in one; D75 is current-gen |
| **Meshtastic ESP32** (T-Beam/Heltec) | LoRa mesh | Web Serial / BLE | LoRa caching/telemetry; web-client pattern exists |
| **LoRa-APRS** (CA2RXU firmware) | LoRa iGate/tracker | serial / APRS-IS | emits plain **TNC2** → existing parser fits directly |
| **RTL-SDR + Direwolf** (Pi) | RX-only SDR | KISS-over-TCP → Path A | receive-only corroboration, no TX-licence risk |
| **Direwolf** (software TNC) | soundcard modem | KISS-over-TCP → Path A | the 24/7 IGate/digi path; FX.25/IL2P |
| SignaLink USB | audio-only, VOX | Web Audio | legacy/simple; no CAT — DigiRig supersedes it |

## Standards to adopt (interop, don't reinvent)
1. **KISS** — already in `@aprsweb/aprs` (`kissFrames`/`kissWrap`).
2. **BLE-KISS API** (`hessu/aprs-specs`, OH7LZB — implemented by aprs.fi iOS + Mobilinkd) — adopt for
   Web Bluetooth so the Mobilinkd/Kenwood ecosystem just works. Single highest-leverage browser standard.
3. **AGWPE / KISS-over-TCP** — already spoken by Path A; lets Direwolf or any networked TNC attach.
4. **FX.25 / IL2P** (NinoTNC, Direwolf) — decode-yield for stronger Tier-A (`docs/08` BL-01); RX-side
   wrapper, backward-compatible (FX.25) — changes yield, not the trust model.

## Trust-model tie-in (why this is more than connectivity)
- A browser-direct or box **receiver is another independent IGate** → more independent receptions per
  beacon → more finds reach **Tier A** (the federation corroboration in `docs/15` benefits directly).
- A phone **decoding its own soundcard** is a first-party, in-app reading — the app-corroborated (Tier B)
  path, not a bare IS packet.
- **Invariant:** hardware ingest never auto-upgrades trust on its own — RF reception still goes through
  `verify.ts` (independent-IGate + plausible-track gating). Transport ≠ trust.

## Schema / cost / rules
- **No schema change.** Transports register through the existing `ports`/transports tally
  (`GET /api/ports`); browser-direct frames either render locally or POST to `/ingest` like any source.
- **Cost:** Path B runs entirely client-side (no server/daemon); Path A keeps the existing batch-POST +
  filter caps. No new always-on connections introduced by the browser path.
- **ui-ux/css:** a grouped, toggle-gated **Workbench → Devices** surface (per ui-ux §2): each transport
  is a master-switched group (Serial / Bluetooth / Audio TNC / Mesh) with a one-line reason when
  unavailable (e.g. "Web Serial needs Chromium" / "pair a BLE TNC"). Connect is a single explicit
  user-gesture action; never auto-opens hardware. Honors reduced-motion; no inline styles.
- **Refactor note:** KISS framing is already pure in `@aprsweb/aprs`; keep new transports as thin
  byte-stream adapters in `apps/web/transports/` and `apps/ingest/` — never duplicate codec logic.

## Milestones (H-phases — "hardware")
- **H1 — Web Serial KISS:** connect a USB KISS TNC from the SPA; locally-heard stations on the map with
  no cloud feed; optional forward to `/ingest`. (NinoTNC / TH-D75 / DigiRig CDC.)
- **H2 — Web Bluetooth BLE-KISS:** pair a BLE TNC via the BLE-KISS API (Mobilinkd TNC4, TH-D74/D75 BT).
- **H3 — Meshtastic/LoRa browser-direct:** Web Serial/BLE node positions + messages into the map.
- **H4 — Soundcard AFSK (Web Audio):** in-browser Bell-202 modem; HT + audio cable, no TNC; VOX/RTS PTT.
- **H5 — TX from the browser (gated):** KISS/AFSK transmit (beacon, message, ack) — **off by default,
  callsign-verified + explicit opt-in**, same gating as the box's IGate/digi TX.
- **H6 — Web Serial CAT (one-click tune)** *(from POTACAT, `docs/20`; full design in `docs/21`)*: drive
  a transceiver's frequency/mode over Web Serial (Kenwood / Icom CI-V / Yaesu) so clicking a
  cache/station/spot tunes the radio to the APRS frequency (144.800 / 144.390) or the spot's freq+mode.
  Rig profiles; Chromium-only. RX-only by default; any keying still H5-gated. The 200+ rig long tail +
  iOS/non-Chromium go through the **Hamlib companion** (`docs/21`), not the browser.
- **Path A deepening (parallel):** native Meshtastic protobuf over MQTT/BLE/serial; AGWPE; more transports.

## Non-goals
No off-grid/no-internet emergency mode (it's a web app). No iOS browser-direct RF (Safari lacks the APIs;
use Path A or a native/PWA-BLE shell later). No reinventing KISS/AX.25/BLE-KISS — adopt the specs above.

## Acceptance (abbreviated)
- **H1:** with a USB KISS TNC attached in Chromium, locally-heard stations appear on the map offline;
  Firefox/Safari show a clear "needs Chromium" reason, not a broken control.
- **H2:** a Mobilinkd/Kenwood BLE TNC pairs via the BLE-KISS API and streams frames.
- **H3:** a Meshtastic node's positions import over Web Serial/BLE.
- **H4:** a recorded Bell-202 sample decodes in-browser; a generated beacon round-trips through a radio.
- **H5:** TX is impossible until the callsign is control-verified and the user opts in; default is RX-only.
- All paths: frames deframe via `@aprsweb/aprs` (no duplicated codec); RF receptions still earn trust
  only through `verify.ts`.
