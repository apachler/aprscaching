# CAT rig control & companion apps (closing the RF gaps)

Status: **Backlog spec.** Give users **CAT control of their transceivers** (tune/mode/PTT from the
platform) and **close the RF-interfacing gaps the browser can't reach** with companion apps. Adopts
WAAT's *pattern* (serial → clean WebSocket/JSON-RPC API) but **not** its rig engine — WAAT stalled at
one rig (Yaesu FT-450D) with "more rigs" + "capability negotiation" still TODO. Build against
`docs/16` (RF hardware), `docs/20` (remote control), `docs/19` (APRS-IS id), `.claude/rules/*`.

## 1. CAT control — one API, two backends (don't reimplement Hamlib)

A single **rig-control API** — `setFreq/getFreq · setMode · PTT · getCapabilities · raw-passthrough ·
status-push` (JSON-RPC/WS, à la WAAT) — served by two interchangeable backends:

- **Backend A — browser-direct (Web Serial CAT, `docs/16` H6).** Implement the common protocol
  *families* in JS: **Kenwood** ASCII, **Icom CI-V**, **Yaesu** CAT. Zero install; covers most popular
  rigs; Chromium (desktop solid, Android emerging — see §4). This is "WAAT-in-the-browser," but
  multi-protocol from the start.
- **Backend B — Hamlib companion (`rigctld`).** For the **200+ rig long tail**, iOS, non-Chromium, and
  headless. `rigctld` already exposes a simple TCP protocol **with per-rig capability negotiation** —
  exactly WAAT's missing piece, solved — and is the de-facto standard (POTACAT/WSJT-X/fldigi all use
  it). The companion wraps it and bridges through the gateway command channel (`docs/20` R1).

The web app's "click a cache/station/spot → tune to the APRS frequency (144.800 / 144.390) or the
spot's freq+mode" calls the same API regardless of backend; rig profiles select the backend + port.

**On the alternatives:** **OmniRig** = Windows-only COM automation → at most a Windows companion
backend / interop target; **grig** = a GTK Hamlib frontend → reference only. Both confirm **Hamlib is
the abstraction to build on**, not to reinvent.

**Licensing:** Hamlib is (L)GPL. We **shell out to `rigctld` over TCP as a separate process** (no
linking) — clean separation that keeps our AGPL app / MIT libs uncontaminated (same approach POTACAT
uses for Hamlib). Never link Hamlib into `packages/*`.

## 2. Companion apps — what the browser can't reach

Gaps no browser closes: **iOS** (no Web Serial/USB/BLE in Safari), **Android** (Web Serial only just
arriving — §4), **Hamlib** (native, can't run in a browser), **always-on/background/headless**
(IGate/digi/24-7 + background can't live in a tab), and native protocols (Meshtastic protobuf, AGWPE,
direct serial).

### 2a. Linux / Pi / desktop companion = `apps/ingest`, productized *(highest leverage — ~80% done)*
`apps/ingest` is already a headless Node station (KISS/CoT/Meshtastic/IGate/digi). Extend it into the
companion daemon:
- **Hamlib/`rigctld` CAT** (Backend B) exposed via the rig-control API.
- **Gateway command channel** (`docs/20` R1) — the box holds an outbound authenticated connection;
  the platform sends signed beacon/message/TX-IGate/CAT commands (no inbound ports). H5-gated.
- **Easy packaging** — `docker run` / `.deb` / AppImage (the `docs/06` "make self-hosting trivial"
  goal). One install gives a user RF I/O + rig control + remote operation.

### 2b. Mobile companion = a Capacitor shell (reuse the web app) — DECIDED
Wrap the existing React app with **Capacitor** + native plugins, rather than a second codebase:
- **USB-serial** (Android USB-host) — KISS TNCs + CAT where the browser can't.
- **BLE-KISS** (Mobilinkd / the `docs/16` BLE-KISS API) — *the only* way to get RF on **iOS** (iOS
  apps can do BLE; the browser cannot).
- **Background service** — keep a session/IGate alive when the screen's off (browsers can't).
- Everything else (map, caching, logging, identity) is the **same web bundle** — the shell adds only
  the native hardware bridge behind the same rig-control / transport APIs.
- **Re-scope trigger:** as Web Serial on Android matures (§4), the native need may shrink to "BLE +
  USB-host + background" only. APRSdroid is the precedent for the Android RF role.

## 3. Architecture (one diagram)
```
web app (React) ── rig-control API (JSON-RPC/WS) ──┐
   │  Backend A: Web Serial CAT (Chromium)          │  same API, pick a backend per rig profile
   │  Backend B: gateway → companion → rigctld ◄────┘
companion (apps/ingest, AGPL)  ── shells out → rigctld (Hamlib, separate process, TCP)
mobile (Capacitor shell)       ── native: USB-serial · BLE-KISS · background
```

## 4. Platform reality (correct `docs/16`)
- **Web Serial:** desktop Chromium solid since Chrome 89; **Android only emerging** — Chrome 148 beta
  (Apr 2026) added it **Bluetooth-RFCOMM-first**, with USB-serial on a limited device set ~2026Q2.
  Treat Android Web Serial as **not yet dependable** → the companion covers it. (Update `docs/16`'s
  "Chromium desktop/Android" to "desktop solid; Android emerging.")
- **Web Bluetooth / WebUSB:** Android Chrome ✓, iOS ✗. **iOS RF = the Capacitor shell (BLE) only.**

## 5. Rules / trust / cost
- **TX always gated:** any keying (CAT PTT, beacon, message) requires control-verification + explicit
  opt-in (`docs/16` H5, `docs/19`); RX/tune-only by default. The companion executes only commands
  signed for the callsign it's licensed to operate.
- **Transport ≠ trust:** rig control and RF reception never alter a find's A/B/C tier (`verify.ts`).
- **Cost:** CAT/command traffic reuses the box's existing outbound connection (no inbound ports, no
  new always-on infra); browser-direct CAT is entirely client-side.
- **ui-ux/css:** rig control is a grouped, toggle-gated **Workbench** surface (not the cacher map);
  one primary action; tokens only.

## 6. Milestones
- **C1 — rig-control API + browser CAT (Backend A):** Kenwood/Icom-CIV/Yaesu over Web Serial; one-click
  tune to APRS freq. (Pairs `docs/16` H6.)
- **C2 — Hamlib companion (Backend B):** `apps/ingest` wraps `rigctld`; rig-control API over the
  gateway channel; capability negotiation.
- **C3 — companion packaging:** `docker run` / `.deb` / AppImage for the Linux/Pi box.
- **C4 — Capacitor mobile shell:** USB-serial + BLE-KISS + background; iOS via BLE; reuses the web app.
- **C5 — remote rig control:** drive Backend B from the web app (folds into `docs/20` R2).

## 7. Acceptance (abbreviated)
- From the web app on Chromium, a user one-click-tunes a supported rig over Web Serial; PTT stays
  disabled until verified + opted in.
- A `rigctld`-backed companion controls a long-tail rig the browser doesn't implement, with
  capabilities reported per rig.
- The Capacitor app on iOS connects a BLE-KISS TNC (impossible in iOS Safari) and keeps a session in
  the background; on Android it talks to a USB-serial TNC.
- Hamlib runs as a separate process (TCP), never linked into the app/libs.
- No rig control or reception changes a find's trust tier.
