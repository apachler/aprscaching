# Heritage adoptions — the original APRSCaching vision + Graphic Packet (hardware, UX, the Tools plugin system)

**Project:** aprscaching.com · **Owner:** OE8APR
**Doc type:** Source-material analysis + adoption proposal. Feeds the roadmap (`docs/26`).
**Status:** PROPOSED. Two source materials analysed: (A) the **original APRSCaching concept** (OE8APR's
own write-up from the defunct *socialhams* platform, supplied as PDF); (B) **Graphic Packet (GP)**, the
classic DOS/Windows multi-channel packet terminal (`dnx274.org/markus/gp`).
**Provenance note:** the GP source pages (`dnx274.org`) were network-policy-blocked from the build
environment, so the owner supplied the original docs directly as PDFs: the **GP85 FAQ** (DG5OAC), the
**DOS `GP.FAQ`** (DL9NEC), and **DG8NFY's command reference**. Part B below is now **confirmed against
those originals** (driver/GPLSL model, `NAMES.GP` station registry, parser plugin DLLs, autorouter,
ANSI, Multiport, BayCom/TFPCX, GPRI helper programs).

---

## Part A — The original APRSCaching vision (socialhams) and our gaps

### A.1 Condensed core idea
APRSCaching = **geocaching with an amateur-radio identity**, where *the logbook entry is made by APRS*
so the logger's **actual presence at the cache is verified by radio**. A cache is found by being near
it and **beaconing your position**; the system auto-logs the find (and uses the **beacon comment as
the logbook text**). Two original twists define it:

1. **Living caches.** A ham *is* a cache: any APRS station (mobile/portable/HT/phone-APRS/weather
   station/IGate) that beacons becomes a findable, **position-updating** cache (`callsign-SSID`; the
   cache's coordinates auto-update from its first beacon). Static geocaches can't move; living caches
   can — the whole point.
2. **The rendezvous/meeting log.** Two *living* caches who meet (pass each other, a quick QSO on
   145.500, arrange a meeting point) **both log each other** — a deliberately social "make new
   acquaintances" mechanic, not just object-hunting.

Cache taxonomy in the original: **single-stage** = *APRS (living)* · *Virtual* (a location/riddle/
landmark, no container); **two-stage** = *Audio* (a hidden recorder plays a **digital-mode signal —
CW/PSK31** — whose content carries the stage-2 coords) · *NFC* (an NFC tag holds the stage-2/target
coords); **other** = *GeoCache* (traditional/multi/mystery container + logbook). Caches carry
name, description, hint, country, **10-digit locator** + lat/lon, **difficulty** (Easy→Extreme) +
**terrain** (handicapped-accessible→special-equipment), tags, the APRS callsign+SSID, stage-2 target,
and **media attachments (photos/videos/sounds/data files)** — explicitly for hints, technical
descriptions, **circuit diagrams of homebrew kits**, and the cache's audio sample. Owners may **allow
rating**. A *Drive-In* is a car-accessible cache.

### A.2 Where our platform already exceeds the original
- **Verification is far stronger.** The original just trusted "you beaconed nearby." We have the
  **A/B/C trust model** (`verify.ts`): RF-corroborated (independent IGate + plausible track) vs
  app-geo vs IS-only, with anti-spoofing + federation corroboration. The original's "log by beacon"
  is our Tier C/A path, hardened.
- **Living caches + become-a-cache:** built (`aprs_living` type, `account_stations`, become-a-cache).
- **Difficulty/terrain, stages (geo/audio/puzzle unlock), hint/description/owner, federation, profiles,
  workbench:** all built and well past the original.

### A.3 Gaps vs the original vision (fidelity gap-closure — feeds `docs/26` Stage 0)
| # | Gap | Original | Us | Proposal |
|---|-----|----------|----|----------|
| F-1 | **Virtual cache type** | location/riddle/landmark, no container | `traditional` only | add `virtual` cache type (location + question/landmark; reward = the place + log) |
| F-2 | **NFC stage unlock** | NFC tag holds stage-2 coords | unlock = coords/audio/puzzle | add **NFC unlock** — read a tag in-browser via **WebNFC** (Android Chromium) to reveal stage 2; non-NFC fallback (manual code) |
| F-3 | **Cache media attachments** | photos/videos/sounds/**circuit diagrams**/data | none on caches (R2 exists) | cache media via **R2** (`MediaStore`): images/audio/files on a cache + its stages; size/type limits, owner-managed |
| F-4 | **Living-cache rendezvous log** | two living caches meeting both log each other | not modelled | a **meeting/rendezvous find**: when two opted-in living caches are co-located + both beacon in a window, mutually log (Tier follows the same engine; a lovely social hook) |
| F-5 | **Digital-mode audio decode** | Audio cache plays **PSK31/CW**; logger decodes | AFSK only (H4) | in-browser **PSK31 + CW (Morse) decoders** (Web Audio) for audio caches — ships as **Tools** (Part B.3), reusing the H4 audio pipeline |
| F-6 | **Owner-gated rating** | "Allow rating" | favourites (M4) | optional: a 1–5 cache **rating** (owner toggles who may rate); or formally treat favourites as the rating (decide) |
| F-7 | **10-digit locator** | extended-precision Maidenhead | 6-char grid + MGRS | accept/display **10-char Maidenhead** on cache create + the coord readout |
| F-8 | **Drive-In / country / tags** | metadata | partial | a `drive_in` flag + country (derive from coords) + free tags on caches |

F-1…F-5 are the meaningful ones (they restore the *character* of the original); F-6…F-8 are small
metadata. F-2 (WebNFC) and F-5 (PSK31/CW) are also great modern-browser showpieces.

---

## Part B — Graphic Packet adoptions (hardware, terminal UX, the Tools plugin system)

*GP (Markus Kohlhase, DH0/DL — successive versions through GP85) was a graphics-mode, multi-channel
DOS/Windows packet terminal: many simultaneous AX.25 connections each in its own resizable window, a
monitor window, a per-channel status line, function-key macros, a built-in mailbox, a station-type
registry, parser plug-ins, and a **driver layer (GPLSL)** that abstracted several TNC/modem/host
families behind one interface. The following maps GP's confirmed strengths onto our stack.*

### B.1 Hardware — strengthen TNC / modem / rig support (feeds `docs/16` + `docs/25` P1/P4)
GP's reach came from the **GPLSL driver layer** — a thin "link-system layer" that let the same terminal
drive radically different back-ends (a KISS TNC, a WA8DED hostmode TNC, a **BayCom/TFPCX software
modem**, **PC/FlexNet**, or an internal loopback) by swapping the driver, not the app. That is exactly
the **transport abstraction** our `apps/ingest` should own. We currently do **KISS** (H1/H2) +
**software L2 over soundcard AFSK** (H4) + the operator-local ingest. Adopt, in priority order:

- **WA8DED / "TheFirmware" hostmode** (and the **TFPCX/TFKISS** TSR that emulates it) — the classic
  *multi-channel* host protocol GP leaned on. The TNC (or TFPCX) manages several connected-mode
  channels and reports them over a framed host link. Add a **hostmode transport** in `apps/ingest`
  (and, for a USB-CDC device, browser Web Serial) **alongside KISS**: a smart TNC offloads L2 and runs
  many QSOs — complementing our pure `packages/ax25` (which does L2 in software for dumb-KISS TNCs).
- **AGWPE (AGW Packet Engine) TCP interface** — the de-facto multi-port/multi-application TNC server
  (Direwolf, SoundModem, UZ7HO all speak it). Add an **AGWPE client transport** to `apps/ingest`
  (and an AGWPE *server* face later) so any AGWPE-compatible modem/soundcard feeds us over TCP — the
  single highest-leverage interop after KISS. (Already flagged in `docs/16`.)
- **PC/FlexNet driver + autorouting** — GP ran natively over **PC/FlexNet**, where you type a
  destination call and the network finds the path; GP also **learned and reversed digipeater paths**
  (auto-build the return route from a heard path) and rendered the reachable network as an **AX.25
  node/route tree**. Fold **autorouting + reversible learned paths** into our NET/ROM node
  (`docs/25` P4): connect by alias, let the node route, and surface the learned-route tree in the UI.
- **PTT over serial RTS/DTR** — GP's **BayCom**-style keying drove **RTS/DTR as PTT**. For the
  no-TNC/soundcard TX path (pairs H4/H5/H6), drive RTS or DTR as PTT over Web Serial. Cheap, unlocks
  audio TX on any CAT-less radio.
- **Multiport** — GP's **Multiport** gave each radio port its own **MYCALL/SSID** and parameters. Our
  terminal (P1) and node (P4) must be **multi-link and multi-port** from day one (many channels across
  several ports) — already in the P1 plan; GPLSL/Multiport reaffirm it and pin the per-port identity
  model.
- **Historical/optional:** BayCom **SER12/PAR96** serial/parallel software modems — superseded for us
  by soundcard AFSK (H4); note for completeness, build only on demand.

### B.2 Terminal UX — adopt into `docs/25` P1 (the browser packet terminal)
- **Multi-channel windows** (per-connection, resizable), a **monitor** pane, and a **status line**
  (per-channel link state / retries / T1) — already P1; GP confirms the shape.
- **`NAMES.GP` station-type registry** — GP shipped a user-editable table that **tagged heard calls by
  type** (`B>` BBS/mailbox, `N>` node, `D>` DX-cluster, `T>` … etc.) and **colourised/iconified** them
  in the monitor and connect lists. Adopt a **station-type registry**: tag heard calls (BBS, node,
  DX-cluster, digi, weather, our own service SSIDs) and drive monitor colour + connect-menu grouping
  from it. Ships seeded; user/Tool-extensible. (Pairs the late-90s flip — this is half its look.)
- **Function-key macro bar + autotext**: user-defined **macros** bound to F-keys with placeholders
  (callsign, date, channel), a **connect-text (CTEXT)** auto-sent on incoming connect, and a
  **quit-text (QTEXT)**. Add to P1 — small, high-nostalgia, high-utility.
- **ANSI colour terminal** — GP rendered remote **ANSI** colour/box-drawing (BBS menus came alive).
  The terminal pane MUST interpret a safe **ANSI subset** (SGR colour, cursor) so F6FBB/BPQ menus and
  our own Cogmind-themed BBS render as intended. (Token-mapped to the active theme — see `docs/24`.)
- **Personal mailbox / auto-answer**: GP's built-in **PMS** → our **BBS Stage-1** + an **auto-responder
  Tool** (B.3) that answers an incoming connect with a greeting/mailbox menu.
- **Cross-connect / "durchconnect"** — GP let you bridge two channels (act as a relay between two
  stations). A small, later node feature (P4); note for completeness.
- **Binary file transfer (7PLUS / AutoBIN / YAPP)** over a connected link — GP supported 7PLUS split
  files and AutoBIN; ships as a later **Tool** or P2+ extension.

### B.3 The headline: a community **Tools** plugin/scripting system (the modern "GP extensibility")
GP was genuinely extensible — and the originals confirm **three** distinct extension mechanisms, not
just macros: (1) **parser plug-in DLLs** that taught the terminal new protocols/screens (the mail
manager / "Boxmelker", `DieBox.DLL`-style boxes — third-party code loaded at runtime); (2) **GPRI
helper programs** GP could launch and exchange data with, including **`//PW` password-automation**
sequences (the BBS/node login was *scripted*, not typed); (3) **macros / command-files** bound to
keys. That is a strong heritage precedent for a real plugin surface. The owner wants that spirit
**modernised into a user-contributable plugin model**. Propose **"Tools" — sandboxed plugins** that
extend the workbench/terminal without touching core code (our safe, capability-gated answer to GP's
load-a-DLL extensibility):

- **Runtime:** **Lua** in the browser via **`wasmoon`** (Lua 5.4 → WASM) or **Fengari**, *or* a tightly
  restricted JS worker. Lua matches the ham/retro flavour and is trivially sandboxable. Each Tool runs
  in a **capability sandbox**: **no ambient network/DOM/filesystem** — it only sees the host API it's
  granted.
- **Host API (the extension points):** register a **command** (a `/word` in the terminal/BBS); hook
  **events** (`on_frame(monitor)`, `on_connect`, `on_disconnect`, `on_beacon`, `on_find`,
  `on_spot`); contribute **monitor filters/colourisers**; provide **decoders** (PSK31/CW/AFSK → the
  F-5 audio-cache decoders ship as built-in Tools); schedule **beacons**; add a small **panel/overlay**
  or a **map layer** (declarative, theme-aware). Strict, versioned API; reduced-motion + a11y inherited.
- **Distribution:** a Tool is a **signed manifest + Lua/JS** (`tool.json`: name, author callsign,
  permissions, entry). Ship a **curated built-in set** (PSK31/CW decoders, auto-responder, a CTEXT
  macro pack, a monitor colouriser, a beacon scheduler); allow **import by URL/file** with an explicit
  permission prompt; a community **registry/marketplace** is a later phase.
- **Why it fits us:** it turns the workbench into a **platform** (the "full APRS workbench" mission),
  gives the community a contribution surface beyond PRs, and cleanly homes niche features (digital-mode
  decoders, exotic beacons, club-specific automations) **outside** the MIT cores. Licence-clean: Tools
  are user content; the host API is ours; `wasmoon`/Fengari are MIT.
- **Guardrails:** capability-gated (network/TX/geo each require explicit grant + the existing H5/
  control-verification gates for anything that *transmits*); CPU/time budgeted; a Tool can **never**
  bypass `verify.ts` trust or the TX gates. Off by default; opt-in per Tool.

> A Tool system is a meaningful new capability — it warrants its own implementation doc when scheduled.
> This section is the design seed; `docs/26` carries it as a roadmap item.

---

## Adoption summary → roadmap mapping (`docs/26`)
- **Stage 0 (loose ends) gains** the APRSCaching *fidelity* cluster F-1…F-8 (virtual type, WebNFC
  unlock, cache media via R2, rendezvous log, PSK31/CW decoders, rating, 10-char locator, drive-in).
- **Stage 1 (packet) gains** the GP **hardware** adoptions — the **GPLSL-style driver abstraction**
  (hostmode/TFPCX, AGWPE, PC/FlexNet, BayCom), **RTS/DTR PTT**, **autorouting + reversible learned
  paths + node tree** (P4), and **Multiport** per-port MYCALL — into P1/P4 + `docs/16`; and the GP
  **terminal UX** — **function-key macros, CTEXT/QTEXT, the `NAMES.GP` station-type registry, and an
  ANSI-colour subset** — into P1.
- **The Cogmind/retro flip** draws directly on GP's look: the `NAMES.GP` colourised station registry +
  ANSI terminal are half its visual character (feeds the merged theme stage).
- **A new roadmap item — the Tools plugin/scripting system** — slots after the terminal exists (P1),
  since the terminal/BBS are its first extension surfaces; the F-5 decoders are its first built-ins.
  GP's parser-DLL + GPRI `//PW` scripting is its heritage precedent.
