> **Status: reference backlog — the built RF/hardware surface is in `docs/design/16-rf-hardware-interfacing.md`.**
> This remains a useful catalogue of amateur modes/transports and their upstreams; treat it as the
> wide-angle reference, and `docs/design/16` as the record of what's implemented.

# Amateur Radio Modes & Transports — Backlog

> Reference backlog for the APRS workbench / APRScaching platform.
> Each item is a discrete mode or transport with a brief, current state, and the **canonical upstream** (repo root / project page) so links always resolve to the latest release rather than a pinned version.
>
> **Last verified:** 2026-06-25
> **Legend — status:** `core` = already in scope · `eval` = worth evaluating · `ref` = reference / interop only
> **Legend — kind:** `mode` = on-air waveform/protocol · `transport` = carries higher-level data · `app` = software implementing a mode

---

## 1. APRS & packet foundation (core to the platform)

### [ ] BL-01 — AX.25 `mode` `transport` `core`
- **Brief:** Link-layer packet protocol underneath APRS (UI frames), packet BBS, NET/ROM. 1200 baud AFSK (Bell 202) / 9600 baud G3RUH.
- **State:** Stable, decades old. Its strongest living role today is APRS itself (Winlink has largely moved to VARA/ARDOP/Pactor).
- **Spec:** AX.25 v2.2 (4th ed., the one the APRS doc project references) — https://www.ax25.net/AX25.2.2-Jul%2098-2.pdf · TAPR hub https://www.tapr.org/pub_ax25.html
- **KISS TNC spec:** http://www.ax25.net/kiss.aspx
- **FEC extensions (decode-yield, not trust-model):**
  - **FX.25** — Reed-Solomon FEC *wrapper* around AX.25; fields chosen so a non-FEC decoder still reads the inner packet → 100% backward compatible. Created by Stensat Group (2005, TAPR DCC 2006). Spec: WB2OSZ "AX.25 + FEC = FX.25" in the Dire Wolf `doc/` folder · overview https://en.wikipedia.org/wiki/FX.25_Forward_Error_Correction
  - **IL2P** — modern successor (Nino Carrillo, KK4HEJ). Reed-Solomon FEC, higher throughput/accuracy than AX.25 or FX.25, but **not** AX.25-compatible (run on a separate port). Draft spec v0.6 (2024). Overview https://en.wikipedia.org/wiki/Improved_Layer_2_Protocol
  - Both implemented in Dire Wolf (BL-03): FX.25 RX on by default; IL2P added in 1.7.
- **Relevance:** Already in `packages/aprs`. Reference spec for the TNC2/KISS edges of the ingest path. **FX.25/IL2P raise decode yield in marginal RF → more independent receptions per beacon → stronger Tier-A corroboration. They change the yield, not the trust model. FX.25 is the safe default (backward compatible); IL2P needs both ends.**

### [ ] BL-02 — APRS / APRS-IS `mode` `transport` `core`
- **Brief:** The application layer you're building on. Position/object/message/weather payloads over AX.25 (RF) and APRS-IS (internet).
- **State:** Stable; q-construct semantics (qAR/qAC/qAX) are the key signal for RF-vs-injected origin in your verification tiers.
- **Spec — ⚠ APRS101.PDF is OBSOLETE for implementation (per APRS Foundation / WB2OSZ):**
  - **Practical modern spec:** `wb2osz/aprsspec` → **APRS12c.pdf** (compiles APRS101 + 2004 errata + Bob's 1.2 proposals). https://github.com/wb2osz/aprsspec
  - Gentle companion: `Understanding-APRS-Packets.pdf` (same repo).
  - ⚠ Clean-room caveat: the compilation is **unofficial** and does **not** distinguish widely-implemented features from dead proposals — don't treat every entry as normative. "Official" position is still APRS101 + Bob's errata at http://www.aprs.org/aprs11.html and http://www.aprs.org/aprs12.html.
- **Device IDs (tocalls) — old `aprs.org/tocalls.txt` + `mic-e-types.txt` are DEPRECATED:**
  - Maintained DB: https://github.com/aprsorg/aprs-deviceid (Hessu OH7LZB)
  - Machine-readable feeds (pull at build time, don't hardcode): `https://aprs-deviceid.aprsfoundation.org/tocalls.yaml` (also `.dense.json` / `.pretty.json` / `.xml`)
- **Symbols:** `APRS-Symbols.pdf` in `wb2osz/aprsspec` — current icon table + on-air encoding for the live map.
- **APRS-IS:** http://www.aprs-is.net/ (server protocol, q-constructs, filters)
- **Authentication (open topic):** APRS has **no built-in auth** → inherently spoofable, which validates the Tier-C treatment of IS-only packets. KA2DDO proposal (digital signatures / challenge-response / tokens): https://www.ka2ddo.org/ka2ddo/ARETF-APRS-Authentication.txt · overview https://how.aprs.works/aprs-message-authentication/. **Design note:** even a future *signed* announce packet must stay out of corroboration for its own log (no-circular-corroboration). Track so the WebAuthn identity layer complements any emerging on-air standard.
- **Relevance:** First-class. The trust-model spine of APRScaching.

### [ ] BL-03 — Dire Wolf (software TNC) `app` `core`
- **Brief:** The de-facto software modem/TNC: AFSK 1200/9600, KISS + AGWPE interfaces, IGate + digipeater. Also an **APRStt gateway** (see BL-20) and implements **FX.25 + IL2P** FEC (see BL-01).
- **Where to get / source:** https://github.com/wb2osz/direwolf
- **License:** GPL-2.0
- **Relevance:** Candidate RF-side modem for an independent IGate (Tier A corroboration) and for any local AX.25 port on the workbench. One binary covers the modem, FEC, IGate, digipeater, and APRStt-gateway roles — so several backlog items collapse onto this one dependency.

### [ ] BL-04 — LoRa-APRS `transport` `eval`
- **Brief:** APRS over 433 MHz LoRa with iGate/digipeater/tracker firmware. Bridges into APRS-IS.
- **State:** Original OE5BPA repos are stable but **the actively-maintained fork is CA2RXU** (updates through 2026). A compressed variant (APRS 434) exists for range. Note: LoRa-APRS carries **plain-text TNC-2 monitoring format**, not bit-stuffed AX.25 — your existing TNC2 parser path already fits.
- **Where to get:**
  - OE5BPA (origin): https://github.com/lora-aprs/LoRa_APRS_iGate · https://github.com/lora-aprs/LoRa_APRS_Tracker
  - **CA2RXU (actively maintained):** https://github.com/richonguzman/LoRa_APRS_iGate · https://github.com/richonguzman/LoRa_APRS_Tracker
  - APRS 434 (compressed): https://github.com/aprs434 · spec https://aprs434.github.io
- **Relevance:** Alternative RF ingest path that isn't classic 144 MHz; same T-Beam/Heltec hardware as the mesh stacks below.

### [ ] BL-20 — APRStt (APRS Touch-Tone) `mode` `eval`
- **Brief:** WB4APR scheme letting a user with **only a DTMF-capable HT** (no TNC, no data radio) inject position/status into APRS via a gateway that decodes the tones.
- **State:** Stable, niche. Gateway side implemented in Dire Wolf (BL-03).
- **Spec:** http://www.aprs.org/aprstt.html · Dire Wolf `APRStt-Implementation-Notes` in https://github.com/wb2osz/direwolf (`doc/`)
- **Relevance — UX path, NOT a trust source:** Interesting as the absolute *minimum-equipment logging path* — "I was here" from a basic handheld. **But** a DTMF entry carries no callsign-bound cryptographic identity, and the position is typically the gateway's known location or a grid the user keys in. Treat APRStt-originated logs as **Tier C (uncorroborated) or below**; do not let them feed corroboration. Aligns with the existing spoofability / no-circular-corroboration principles.

### [ ] BL-21 — APRS implementation references (Foundation / WB2OSZ docs) `ref` `core`
- **Brief:** The de-facto modern docs that fill gaps the official spec never covered. Essential because you're building a digipeater + IGate, neither of which has an official spec.
- **Where to get:**
  - Doc hub: https://how.aprs.works (APRS Foundation — modern, curated; assume old aprs.org pages are stale unless cross-checked)
  - Spec/doc repo: https://github.com/wb2osz/aprsspec
  - **Digipeater algorithm:** `APRS-Digipeater-Algorithm.pdf` (WIDEn-N handling, dupe suppression)
  - **IGate operation:** `Successful-APRS-IGate-Operation.pdf` in https://github.com/wb2osz/direwolf-doc (ignore Dire-Wolf-specific parts)
  - **Collision/timing:** `Minimizing-APRS-Collisions.pdf` — informs beacon/announce TX timing & decay
- **Relevance:** Directly feeds the digipeater module, the Tier-A independent-IGate design, and good-citizen TX behaviour for opt-in announce packets.

### [ ] BL-22 — Vendor a pinned `tocalls` snapshot in `packages/aprs` `core`
- **Goal:** Commit a version-stamped snapshot of the device-ID database in-repo so builds/tests are deterministic, reproducible, and network-free — while keeping a clean refresh path so it doesn't silently rot.
- **Why:** The live feeds (BL-02) are the source of truth, but pulling them at build/test time makes CI non-deterministic and offline-hostile. Vendor + refresh is the standard resolution.
- **Approach:**
  - Commit `packages/aprs/data/tocalls.yaml` (or `.dense.json` for smaller diffs) with a sidecar `tocalls.meta.json` recording source URL, upstream commit/version, and fetch date.
  - Parser loads the vendored copy by default; allow an optional runtime override path for consumers who want live data.
  - Add `pnpm --filter @.../aprs run update:tocalls` that fetches from `https://aprs-deviceid.aprsfoundation.org/tocalls.yaml`, rewrites the snapshot + meta, and prints a diff.
  - CI: a scheduled job (cron) that runs the fetch and **fails/opens a PR on drift** so refreshes are intentional, not surprises.
- **Acceptance:** `pnpm test` and build run with networking disabled; snapshot carries provenance metadata; refresh + drift-detection documented.
- **Source:** https://github.com/aprsorg/aprs-deviceid · feeds at https://aprs-deviceid.aprsfoundation.org/
- **Relevance:** Makes BL-02 device identification actionable without coupling builds to an external host.

### [ ] BL-23 — Cross-check `packages/aprs` fixtures vs APRS12c corrections + real captures `core`
- **Goal:** Harden the parser's golden fixtures by reconciling them against (a) the *corrections/clarifications* in APRS12c and (b) a real-world capture corpus — explicitly **not** a blind APRS101→APRS12c swap.
- **Why:** APRS101-derived fixtures can encode 2000-era ambiguities the errata later fixed; and real on-air traffic is messier than any spec example, so spec-only fixtures miss the cases that actually break parsers.
- **Approach:**
  1. **Inventory + tag provenance** of every existing fixture: `apr101` / `live` / `unknown`.
  2. **Extract the deltas** (not the whole spec) from `APRS12c.pdf` + `Understanding-APRS-Packets.pdf` vs APRS101 — timestamp formats, compressed-position handling, Mic-E nuances, position ambiguity — and add one regression fixture per correction.
     - ⚠ Pin only behaviours that are **implemented/observed**, never APRS12c's speculative proposals (the compilation doesn't separate them).
  3. **Capture a real corpus** from a live APRS-IS feed filtered to region (`vie`/OE), including malformed/quirky packets; golden-master the parser output.
     - ⚠ Captures contain real operators' callsigns/positions — keep the committed sample small and consider light sanitisation; note it's public APRS-IS data regardless.
  4. **Split assertions** into "must parse correctly" vs "must fail gracefully" — malformed input must never throw; tolerant-parse + flag.
- **Acceptance:** every fixture tagged by source; each APRS12c correction has a named regression test; a small real-capture corpus committed with golden outputs; fuzzed/malformed inputs handled without exceptions.
- **Relevance:** Directly protects the trust-model spine (BL-02) — a mis-parse can mis-assign a verification tier.

---

## 2. HF weak-signal & beacon modes

### [ ] BL-05 — FT8 / FT4 (WSJT-X) `mode` `ref`
- **Brief:** Dominant HF digital mode. FT8 = 8-FSK, 15 s T/R cycles, ~50 Hz wide, decodes to ≈ −21 dB SNR. FT4 = 7.5 s contest variant. Structured exchanges only (call/grid/report), not conversational.
- **Where to get / source:** https://wsjt.sourceforge.io/ · source https://sourceforge.net/projects/wsjt/
- **Enhanced fork:** WSJT-X_improved (DG2YCB) — http://wsjt-x-improved.sourceforge.io
- **Spec:** "The FT4 and FT8 Communication Protocols" (K9AN/K1JT, QEX 2020), linked from the WSJT-X home page.
- **License:** GPL-3.0

### [ ] BL-06 — WSPR (+ FST4W) `mode` `eval`
- **Brief:** Beacon/propagation mode at sub-watt power; stations beacon, independent receivers spot to a central DB.
- **State:** Part of WSJT-X. Network/DB at https://wsprnet.org
- **Relevance — conceptual:** This is *presence verification* by another name (beacon → independent spotters → DB). Closest existing analogue to your Tier-A RF-corroboration model; worth studying its spotting/dedup logic.

### [ ] BL-07 — Q65 / MSK144 / FST4 `mode` `ref`
- **Brief:** WSJT-X specialty modes — Q65 (EME & weak-signal VHF+ scatter), MSK144 (meteor scatter), FST4 (LF/MF). Same suite as FT8.
- **Where to get:** bundled in WSJT-X (see BL-05).
- **Relevance:** Reference only; relevant if the workbench ever surfaces VHF+ weak-signal activity.

---

## 3. HF keyboard / messaging modes

### [ ] BL-08 — JS8Call (JS8 mode) `mode` `app` `eval`
- **Brief:** FT8 waveform + a messaging/network layer — real-time keyboard chat, store-and-forward, auto relay (Heartbeat). The off-grid/EMCOMM HF messenger.
- **State:** **Active development moved to the `JS8Call-improved` org (v3.x).** The original `js8call/js8call` (v2.3.1) is now legacy.
  - Active: https://github.com/JS8Call-improved/JS8Call-improved
  - Legacy: https://github.com/js8call/js8call
  - Site/downloads: https://js8call.com
- **License:** GPL-3.0
- **Relevance:** Its directed-message + station-announcement model is a useful precedent for beacon-plus-message UX.

### [ ] BL-09 — PSK31 (+ PSK63/125, QPSK) via Fldigi `mode` `app` `ref`
- **Brief:** 31.25-baud BPSK varicode, ~60 Hz wide, real-time keyboard ragchew. The conversational mode FT8 can't be.
- **Where to get / source:** Fldigi (W1HKJ) — http://www.w1hkj.com/ · source https://sourceforge.net/projects/fldigi/ (mirror https://github.com/w1hkj/fldigi)
- **Also covers:** Olivia, RTTY, MFSK, Contestia, Hellschreiber — all in Fldigi.
- **License:** GPL

---

## 4. HF data / EMCOMM transports

### [ ] BL-10 — VARA HF / VARA FM + VarAC `transport` `app` `ref`
- **Brief:** VARA = high-throughput OFDM modem (≤52 QAM subcarriers); largely displaced Pactor/AX.25 for Winlink. VarAC = free real-time chat app on top (~90k users).
- **State:** VARA is **proprietary**, speed-limited without a ~$69 licence. Exposes a **KISS interface** → usable as a TNC replacement for APRS/BBS.
- **Where to get:** VARA modem https://rosmodem.wordpress.com/ · VarAC https://www.varac-hamradio.com/
- **License:** closed source (modem); VarAC is free but closed.
- **Relevance:** Reference for the KISS-over-OFDM pattern; not integratable as open source.

### [ ] BL-11 — Mercury (Rhizomatica) `transport` `eval`
- **Brief:** Fully **open-source** HF modem — the open answer to VARA. Officially released 2026-05-07. "Bit pipe," no integrated apps.
- **Where to get / source:** https://github.com/Rhizomatica/mercury
- **License:** open source
- **Relevance:** If you ever want an *open* high-rate HF data path, this is the one to track.

### [ ] BL-12 — FreeDATA `transport` `app` `eval`
- **Brief:** Open-source HF data platform over codec2 modems — server/client architecture, **REST API**, messaging.
- **Where to get / source:** https://github.com/DJ2LS/FreeDATA · site https://freedata.app · mirror https://codeberg.org/dj2ls/freedata
- **License:** open source (Python)
- **Relevance:** Its server/client + REST API split is architecturally close to your gateway/ingest split — good reference, and DJ2LS is in the FreeDV/RADE test orbit.

---

## 5. Digital voice (open)

### [ ] BL-13 — M17 `mode` `transport` `eval`
- **Brief:** Open, patent-free digital voice **+ data** (4FSK + Codec 2), built as an open alternative to DMR/D-STAR/Fusion. Carries SMS, GNSS position.
- **Where to get / org:** https://github.com/M17-Project
- **Spec:** https://github.com/M17-Project/M17_spec (rendered: https://spec.m17project.org/) — Part I Air Interface, Part II Internet Interface
- **Project / foundation:** https://m17project.org · https://m17foundation.org
- **License:** spec GPL-2.0; code GPL/LGPL
- **Relevance:** Squarely in the open-spec philosophy; its GNSS-position-over-voice frames are a possible future data source.

### [ ] BL-14 — FreeDV + Codec 2 + RADE `mode` `eval`
- **Brief:** Open HF digital voice. Codec 2 = low-bitrate speech codec; FreeDV = the over-radio protocol; **RADE (Radio Autoencoder)** = new ML-based neural codec (FARGAN vocoder), ~3 dB more sensitive in V2.
- **Where to get / source:**
  - Codec 2: https://github.com/drowe67/codec2 (algorithm doc: `doc/codec2.pdf`)
  - FreeDV GUI: https://github.com/drowe67/freedv-gui
  - RADE: https://github.com/drowe67/radae (V2 in active dev, BSD-2-Clause)
  - Project: https://freedv.org
- **Relevance:** Reference; the ML-vocoder-over-HF work is the genuinely novel item in this list.

### [ ] BL-15 — DMR / D-STAR / Fusion (C4FM) via MMDVM `mode` `ref`
- **Brief:** Established networked digital-voice modes reached through hotspots (Pi-Star / WPSD on MMDVM_HS boards).
- **Where to get:** Pi-Star https://www.pistar.uk/ · MMDVM firmware https://github.com/g4klx/MMDVM · host https://github.com/g4klx/MMDVMHost
- **Relevance:** Reference only — closed/standardised vocoders (AMBE), not aligned with the open stack.

---

## 6. LoRa mesh & cryptographic networks (transports)

### [ ] BL-16 — Meshtastic `transport` `eval`
- **Brief:** Open-source LoRa mesh (flood routing), license-free ISM (868 MHz EU / 915 MHz US). Text, position, telemetry. 100+ supported boards.
- **State:** Firmware on the 2.6.x line, very active (MCP server + test framework landed recently). OTA-over-LoRa not supported.
- **Where to get / source:** firmware https://github.com/meshtastic/firmware · **protobufs (the "spec")** https://github.com/meshtastic/protobufs · docs https://meshtastic.org/docs
- **License:** GPL-3.0
- **Relevance:** Candidate mesh transport / position source feeding the live map and ingest.

### [ ] BL-17 — MeshCore `transport` `eval`
- **Brief:** Lightweight **managed-routing** LoRa mesh with explicit node roles (Companion / Repeater / Room Server) — scales better than flood routing for hilltop-repeater backbones.
- **State:** v1.15.0 (Apr 2026). Has a **KISS modem** example for host bridging.
- **Where to get / source:** https://github.com/meshcore-dev/MeshCore · flasher https://flasher.meshcore.io · map https://map.meshcore.io · blog https://blog.meshcore.io
- **License:** MIT
- **Relevance:** Compare against Meshtastic for any backbone topology; the role model maps onto digipeater/IGate thinking. MIT licence is friendlier than GPL for integration.

### [ ] BL-18 — Reticulum + RNode `transport` `eval` ⭐
- **Brief:** Cryptography-based networking stack over LoRa / packet radio / AX.25 / WiFi / anything half-duplex. End-to-end encryption, initiator anonymity, cryptographic identities, **unforgeable delivery acknowledgements**, autoconfiguring multi-hop transport. RNode = the open LoRa transceiver firmware for it.
- **State:** Manual/stack at 1.3.5 (Jun 2026). Runs in userland on anything with Python 3 (incl. Pi Zero).
- **Where to get / source:**
  - Stack: https://github.com/markqvist/Reticulum · `pip install rns`
  - RNode firmware: https://github.com/markqvist/RNode_Firmware
  - Apps: Sideband https://github.com/markqvist/Sideband · NomadNet https://github.com/markqvist/NomadNet
  - Manual/spec: https://reticulum.network/manual/
- **License:** MIT/Reticulum licence (permissive)
- **Relevance — highest read priority:** Its **cryptographic-identity + unforgeable-ack** model overlaps directly with your WebAuthn-identity / anti-spoofing / no-circular-corroboration trust thinking. Study the identity, destination, and delivery-proof primitives before finalising the verification engine — there may be primitives worth borrowing rather than reinventing.

---

## 7. Image

### [ ] BL-19 — SSTV `mode` `ref`
- **Brief:** Slow-scan TV — still images over SSB/FM (Robot, Scottie, Martin modes). ISS runs periodic SSTV events.
- **Where to get:** QSSTV (Linux) http://users.telenet.be/on4qz/ · MMSSTV (Windows).
- **Relevance:** Reference; a possible "audio cache" / media-payload analogue for cache content.

---

## Suggested triage order for the platform

1. **BL-18 Reticulum** — read first; informs the verification/trust model directly.
2. **BL-02 / BL-21 spec hygiene** — swap APRS101 → `aprsspec` (APRS12c.pdf), wire the parser to the live `aprs-deviceid` feeds, and read the digipeater + IGate docs before building those modules.
3. **BL-04 LoRa-APRS (CA2RXU)** + **BL-16/17 Meshtastic/MeshCore** — concrete RF/mesh ingest options on shared hardware.
4. **BL-03 Dire Wolf** — independent IGate for Tier-A corroboration; enable **FX.25 RX** (BL-01) here for free decode-yield gains.
5. **BL-06 WSPR** — study spotting/dedup as a presence-verification precedent.
6. **BL-20 APRStt** — optional low-barrier logging UX, but wire it to Tier C only.
7. Everything else — `ref` unless a specific feature pulls it into scope.

> Note: items marked `core` are part of the existing design; `eval`/`ref` are candidates and references, not commitments.
