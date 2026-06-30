# Packet Radio: AX.25 connected mode, FBB-style BBS, NET/ROM node, digipeater & a Graphic-Packet web terminal

**Project:** aprscaching.com (greenfield revival)
**Doc type:** Architecture & implementation proposal (Claude Code foundation)
**Status:** PROPOSED — not yet built. Large, multi-phase; lands as `packages/ax25` + services + UI.
**Owner:** OE8APR
**Reads with:** `.claude/rules/ui-ux.md`, `.claude/rules/css.md`, `.claude/rules/ingest-locality.md`,
`docs/16-rf-hardware-interfacing.md`, `docs/24-cogmind-theme.md`, `docs/15-federation-next.md`,
the existing BBS (`workers/gateway/src/bbs.ts`) and AX.25 codec (`packages/aprs/src/ax25.ts`).

---

## 1. Why this exists

APRS is a *connectionless* (UI-frame) application that rides on **AX.25**. aprscaching grew out of
APRS, so today the platform only ever speaks AX.25 **UI frames**. But AX.25 is a full link-layer
protocol with a **connected mode** (LAPB-derived), and the classic packet-radio world — **F6FBB**
mailboxes, **BPQ32 / TheNetNode (TNN) / FlexNet / BayCom** nodes and digipeaters, and terminals like
**Graphic Packet (GP)** — all live in that connected mode. The owner wants that world brought back,
**web-native**, with a deliberate late-90s flashback:

1. **AX.25 connected mode is a first-class core capability**, not just UI frames.
2. A real **FBB-style BBS**: the classic command interface, message **threading tree**, and
   **bulletin forwarding with hierarchical routing** (`@ WW`/`@ EU`/`@ DB0ABC.#BAY.DEU.EU`).
3. **Node + digipeater** services (NET/ROM-style switch like BPQ/TNN; BayCom-class digi) **with the
   classic sysop admin/command interface**.
4. A **Graphic-Packet-style multi-channel packet terminal** in the browser.
5. **One product, two skins:** the *modern* theme renders a clean web UI; switching to the **Cogmind
   theme (`docs/24`) transforms the same surfaces into a late-90s green-screen packet experience** —
   command line, monitor pane, function keys, box-drawing — same data and logic underneath.

This is the largest single proposal in the repo. It is deliberately phased so each phase is shippable
and CI-green, and so the **pure protocol cores are testable without hardware**.

---

## 2. Guiding principles (so this stays on-mission)

- **One core, two shells.** The protocol engines and the data/REST layer are presentation-agnostic.
  The *modern* shell (cards/panels — our default) and the *retro terminal* shell (command line +
  monitor + channels) are two front-ends over the **same** gateway APIs and the same AX.25 engine.
  The active **theme** selects the shell. Per `css.md`, presentation is CSS/skin; *interaction model*
  differences (a command-line affordance, a monitor pane) are progressive enhancements layered on
  **real, accessible semantics** — never a CSS hack, never a broken keyboard/AT path.
- **Pure, testable protocol cores.** The AX.25 connected-mode state machine and NET/ROM live in
  `packages/ax25` (MIT, runtime-neutral, zero I/O). They are event-driven: *(frames + timer ticks) →
  (frames + events)*. This makes them unit-testable by scripted exchange — the only way to get a
  link-layer right without a radio. The transports (`docs/16` H1–H6 Web Serial/BLE/audio, and the
  ingest box's KISS/AXIP) are byte pipes plugged into the same engine.
- **Operator-local RF (ingest-locality rule).** Node/digi/BBS-over-RF are **operator-owned services**
  on `apps/ingest` (or browser-direct via the terminal). A cloud box MAY run an IS-side / forwarding
  BBS, but RF services are never cloud-only.
- **Trust model unchanged (`workers/gateway/src/verify.ts`, `docs/22`).** Connected-mode RX is still
  **Tier C** — a BBS/node/terminal is *workbench*, it never touches the A/B/C find tiers. Provenance
  (transport vs trust) is untouched.
- **Reimplement open specs, copy nothing.** AX.25 v2.2 (TAPR/ARRL), NET/ROM, and the FBB forwarding
  protocol are **documented**; we implement the protocols. We do **not** copy GPL'd BPQ32/FBB/TNN
  source, and Graphic Packet (freeware/closed) contributes **UX inspiration only** — borrow the
  pattern (multi-channel + monitor + function keys), never assets. `packages/*` stays MIT-clean: no
  GPL deps in the cores.

---

## 3. Research grounding — what the old systems' interfaces actually are

This is the behaviour the build must reproduce (re-implemented from open specs).

### 3.1 AX.25 connected mode (the missing core)
LAPB-style data link: **U-frames** (SABM/SABME, DISC, DM, UA, FRMR, UI, XID, TEST), **S-frames**
(RR, RNR, REJ, SREJ), **I-frames** (sequenced info). Modulo-8 (SABM) or modulo-128 (SABME/extended).
Window `k`, retries `N2`, timers **T1** (ack/retransmit), **T2** (response delay), **T3** (idle
keepalive). PID identifies layer 3 (`0xF0` none, `0xCF` NET/ROM, `0xCC/0xCD` IP/ARP). State machine:
*disconnected → awaiting-connect → connected → timer-recovery → awaiting-release*. This is the
keystone; everything else connects *through* it.

### 3.2 NET/ROM node (BPQ32, TheNetNode, FlexNet-class)
A **switch** users connect to, then hop across the network. Layer-3 **NODES** broadcasts advertise
`ALIAS:CALLSIGN` reachability with a **quality** metric; layer-4 sets up **circuits**. The classic
user command set at the node prompt:

```
Nodes [+|-|pattern]   list known nodes        Routes               neighbour links + quality
Connect <call|alias>  route a connection       Users                active circuits
Info                  node banner/info         MHeard / J           recently heard stations
Ports                 RF ports                 CQ <text>            call CQ via the node
Bye / Quit            disconnect               Help / ?             command help
```
Sysop adds: password challenge, `PARMS` (timers/quality), port config, link (de)routing, DAMA master
(TNN), CONVERS/round-table chat. BPQ32 also exposes **applications** by alias (BBS, CHAT) and ships a
**web management UI** (config, live node map, mail, chat) — the precedent for *our* web admin.

### 3.3 F6FBB-style BBS (the mailbox)
Message base of **P**ersonal / **B**ulletin / **T**raffic(NTS), each with a network-unique
**MID/BID**. The command prompt:

```
L                new messages          LL n   last n        LB / LP / LT   bulletins/personal/traffic
LM / RM          list / read mine      LC     categories    L@ <route>     by hierarchical route
R n              read msg n            V n     verbose       L> / L<        by recipient / sender
S / SP / SB / ST send (pers/bull/NTS)  SR [n]  reply        K n / KM       kill / kill-mine
I [call]         info / white-pages    A      abort         B / BYE        quit       X  expert
N / NH / NQ      set name / home / QTH  ?/H    help
```
Header line: `From  To  @BBS  BID  Date  Size  Subject`. **Hierarchical addressing**: a bulletin is
`TO-category @ route`, e.g. `SB SALE @ EU` or fully-qualified `@ DB0ABC.#BAY.DEU.EU.WW`
(`bbs.#region.state.country.continent.world`). **Forwarding**: a *forward file* maps category/route
patterns → partner BBS; matching messages queue to that partner. The **FBB forward protocol** (`F>`
prompt) proposes `FB P/B from to @route bid size`, peer replies `FS +/-/=` (accept/reject/already-have),
optional **LZHUF** compression (B1/B2). **BID/MID dedup** stops loops and duplicates. **White Pages
(WP)** is a distributed user→home-BBS directory so personal mail forwards toward its recipient.

### 3.4 Digipeater (BayCom/UI-digi class)
AX.25 frame repeater: **UI digipeating** (APRS `WIDEn-N` — *already* in `packages/aprs/digipeat.ts`)
and **connected-mode/explicit-call digipeating** (repeat by the via-path's next unconsumed hop),
with **alias** support (a node/digi alias like `RELAY`/`WIDE`/a local alias) and dedup. Sysop config:
which ports, which aliases, UI-only vs full, viscous-delay/dupe windows.

### 3.5 Graphic Packet (GP) — the terminal UX to reincarnate
A DOS, graphics-mode, **multi-channel** packet terminal: several simultaneous AX.25 connections, each
in its **own window/channel**; a **monitor pane** showing all heard traffic (colourised by type); a
**status line** (channel, link state, retries, T1); **function-key** command bar (F1 connect, F2
monitor, …); a built-in mailbox. The essence to keep: **channels + monitor + status line + function
keys + command line** — the muscle memory of packet operating.

---

## 4. Architecture — one core, many shells

```
                ┌─────────────────────────── packages/ax25 (MIT, pure) ───────────────────────────┐
                │  ConnectedLink (LAPB state machine)   ·   NET/ROM L3/L4   ·   digi/dedup helpers │
                │  events: frames+timers → frames+data  ·   no I/O, fully unit-tested              │
                └───────────────▲───────────────────────────────────────────────▲─────────────────┘
   transports (docs/16)         │                                                │     services
   Web Serial / BLE / Audio ────┤  browser-direct terminal & node               │  apps/ingest:
   KISS-over-TCP / AXIP ────────┤  (operator-local; ingest-locality)            ├─ Digipeater
                                │                                                ├─ NET/ROM Node
   gateway relay (docs/20) ─────┘  remote box ⇄ browser                         └─ FBB BBS + forwarder
                                                                                        │
   workers/gateway  ── BBS REST + forwarding-over-IP partner (folds in §7 federation) ──┘
                                                                                        │
   apps/web  ──  modern shell (cards)  ⇄  THEME  ⇄  retro terminal shell (GP/FBB green-screen)
```

- **`packages/ax25`** (new, MIT): `ConnectedLink` (the §3.1 state machine), `NetRom` (NODES table +
  circuits), and node/digi pure helpers. Reuses `packages/aprs` framing (`encodeAx25`/`decodeAx25`/
  KISS). Zero I/O; deterministic; the test surface is "feed frames + tick timers, assert frames out".
- **Transports**: the existing `docs/16` browser pipes (H1 serial, H2 BLE, H4 audio) and the ingest
  box's KISS/AXIP feed bytes into a `ConnectedLink`. Same engine both sides.
- **Services** on `apps/ingest` (operator-local): Digipeater, NET/ROM Node, FBB BBS + forwarder.
- **`workers/gateway`**: the BBS REST API (exists), config APIs, the **IP forwarding partner** (so
  today's bulletin federation, §7, becomes one transport of FBB forwarding), and the browser⇄box relay.
- **`apps/web`**: the two shells (§6) over the same APIs + a browser-side `ConnectedLink` for the
  in-browser terminal/node.

---

## 5. The data & routing model (BBS message tree + forwarding tree)

Two distinct "trees" the owner asked for — keep them separate:

**5.1 Thread tree (conversation).** Messages gain `reply_to` (parent MID) + a derived `thread_id`,
so personal mail and bulletins render as **threaded conversations** (FBB `SR` reply chains). The web
shows an indented tree; the retro shell shows `Re:` lineage in the `L`ist + a `RT`hread command.

**5.2 Routing tree (distribution).** The **hierarchical address** is the routing key:
`category @ bbs.#region.state.country.continent.WW`. We store it parsed (`to_category`, `route_path[]`)
and match **forward rules** (longest-prefix on the route tree) → partner links. A new bulletin walks
the rule tree, queues to each matching partner, and **BID-dedups** so it floods the network exactly
once (loop-free) — the same dedup the §7 federation already proves end-to-end. White-Pages resolves a
personal recipient's **home BBS** to steer P-mail through the tree.

Schema (additive, after migration `0028`): `bbs_messages` += `reply_to`, `thread_id`, `to_category`,
`route` ; new `bbs_forward_rules` (pattern → partner, FBB forward file), `bbs_partners` (link defs +
protocol: `rf-fbb` | `ip-fed` | `axip`), `bbs_wp` (white pages), `bbs_forward_queue` (per-partner
outbound + proposal/accept state).

---

## 6. The two shells — modern ⇄ late-90s (the theme transformation)

The flashback is the headline. It is achieved **without forking the app**:

- **Shared semantics.** Every packet surface (BBS, node admin, digi config, terminal) is built from
  real, accessible components and talks to the same APIs/engine. The *modern* theme renders them as
  cards, lists, forms, tabs.
- **Retro shell = Cogmind theme + a "terminal" interaction layer.** `docs/24` already makes Cogmind a
  full-app token theme (phosphor palette, CP437/box-drawing, monospace, "all info visible" HUD). This
  proposal **extends `docs/24`** with a `data-shell="terminal"` mode (auto-enabled under the Cogmind
  theme for workbench/packet surfaces) that swaps *layout + affordances*:
  - a **command line** (real `<input>`, full keyboard) that accepts the FBB/node verbs (`L`, `R 12`,
    `C DB0ABC`, `N`, `B`) **in addition to** the buttons — power-user parity, not a replacement;
  - a **monitor pane** (all heard frames, colourised; the same data the modern "live frames" list
    shows);
  - a **status line** + **function-key bar** (F1–F10 mapped to the common verbs);
  - **box-drawing windows / channels** for the terminal's multiple connections.
  Modern theme → the same React tree lays out as panels/cards; Cogmind theme → green-screen terminal.
- **Constraints hold (`css.md`/`ui-ux.md`).** Real `<button>`/`<input>`/`<dialog>`; visible focus;
  the command line is an *enhancement* over clickable controls (never the only path); **reduced-motion
  kills the cursor blink / CRT flicker**; contrast meets AA in phosphor green; no map/route is broken
  by the skin. The retro shell is, if anything, *more* keyboard-native — good for accessibility.

Result: flip the theme and the BBS/terminal/node literally "transform to the late 90s" — same logic,
same data, same routes.

---

## 7. Relationship to what's already built

- **Bulletin federation (just shipped, `docs/15`/this repo).** It already floods BID-deduped
  bulletins over signed IP feeds and never loops. It becomes the **`ip-fed` partner transport** of the
  FBB forwarder — i.e. FBB forwarding gains a modern, signed, internet partner type alongside classic
  **`rf-fbb`** (connected-mode FBB protocol over RF) and **`axip`** (`docs/22`, reserved). One
  forwarder, three transports; the routing tree (§5.2) drives all three.
- **Store-and-forward personal mail (built).** Stays; gains White-Pages-steered forwarding so P-mail
  can cross the node network toward a recipient's home BBS, not only wait to be locally heard.
- **Digipeater (built, UI/APRS).** `packages/aprs/digipeat.ts` + `apps/ingest/digipeater.ts` already
  do `WIDEn-N`. Extend to connected-mode/explicit-call + alias digipeating and a config surface.
- **Transports (built, H1–H6).** Reused verbatim as the byte pipes for `ConnectedLink`.
- **Remote box relay (`docs/20`).** Lets the browser terminal/admin reach the operator's box (node,
  BBS, digi) without port-forwarding — the modern ECHOCAT.

---

## 8. Phased plan (each phase shippable + CI-green)

- **P0 — AX.25 connected-mode core** (`packages/ax25`, MIT). `ConnectedLink` LAPB state machine
  (mod-8 then mod-128), timers, retries, segmentation. **Pure, exhaustively unit-tested** by scripted
  frame/timer exchange (SABM/UA handshake, I-frame windowing, REJ/SREJ recovery, T1 timeout/retry,
  DISC). *No UI.* The keystone.
- **P1 — Browser packet terminal (Graphic Packet reborn).** Multi-channel connected-mode terminal over
  Web Serial/KISS (then BLE/audio): channels, monitor pane, status line, function keys, command line.
  Modern shell first; Cogmind terminal shell in the same components. Connect to a real BBS/node and
  drive it.
- **P2 — FBB-style BBS uplift.** Connected-mode BBS *server* (ingest) + the full command interface
  over the existing message base; add the **thread tree** (`reply_to`/`thread_id`, `SR`, threaded
  views in both shells). P/B/T typing, MID/BID, expert mode.
- **P3 — Forwarding + hierarchical routing tree.** Parse hierarchical addresses; `bbs_forward_rules`
  longest-prefix routing; the **FBB forward protocol** (proposal/accept, LZHUF B1/B2) for `rf-fbb`
  partners; **fold bulletin federation in as the `ip-fed` partner**; White Pages for P-mail steering.
- **P4 — NET/ROM node + digipeater + admin.** `NetRom` L3/L4 (NODES table, circuits, routing); the
  node user CLI (Nodes/Routes/Connect/Users/MHeard/CQ/Bye); connected-mode digipeater + aliases; the
  **sysop admin/config** surface (modern web forms ⇄ retro sysop console) for node/digi/BBS.
- **P5 — Theme transformation polish.** Complete the `data-shell="terminal"` retro layouts for every
  packet surface under Cogmind; function-key map; monitor colourisation; CP437 chrome; reduced-motion
  + AA verification; one combined teaser showing the modern↔late-90s flip.

Dependencies: P0 → P1 → {P2 → P3, P4}; P5 rides on the surfaces as they land. P0 is the long pole and
must be rock-solid (a flaky link layer poisons everything downstream) — budget the most test effort
there.

---

## 9. Risks, scope & non-goals

- **Connected-mode AX.25 is genuinely hard** (timers, windowing, recovery, mod-128). Mitigation: pure
  engine + heavy scripted tests; validate against a real BBS/node only at deploy (hardware-path
  posture, like H3/H4). Off-air robustness is a tuning concern, clean-path correctness is the CI gate.
- **Don't boil the ocean.** Out of scope (for now): full WP flooding parity, NTS/traffic handling
  depth, DAMA master, FlexNet auto-routing math, binary file areas, TCP/IP-over-AX.25 (44net is
  `docs/22`). Reserve seams; ship the spine.
- **Licensing.** Specs reimplemented; **no BPQ32/FBB/TNN GPL code, no GP assets**; `packages/ax25`
  MIT-clean (LZHUF impl must be an MIT/own implementation, not a GPL lift). Docs CC-BY-SA.
- **Trust.** Reaffirm: none of this touches A/B/C find verification. It is workbench depth (M5+).
- **Effort.** This is multiple milestones of work, not a sprint. The value is staged: P0+P1 alone give
  a working web packet terminal — a strong, demoable flashback — before the BBS/node depth lands.

---

## 10. Open decisions (for the planning chat)

1. **`packages/ax25` vs extend `packages/aprs`?** Lean **new package** (keeps the APRS lib lean/MIT,
   lets the heavy connected-mode core evolve independently; `aprs` depends on it for framing reuse).
2. **Browser node?** P1 terminal is clearly browser-direct. A browser-hosted *node/BBS* is possible
   but session-bound; the durable node/BBS belongs on `apps/ingest` (locality). Propose: browser =
   terminal + ephemeral personal mailbox; box = the real node/BBS.
3. **Retro shell trigger.** Auto-bind `data-shell="terminal"` to the Cogmind theme for packet/workbench
   surfaces (proposed), or make it an independent toggle? Proposed: bound to Cogmind, with a hidden
   escape hatch for users who want terminal UX without the full theme.
4. **Forward protocol scope in P3.** Implement classic FBB (B/B1/B2) for real-world interop, or a
   modern signed JSON forward for `ip-fed` only and FBB later? Proposed: `ip-fed` (signed, already
   proven) first; FBB-over-RF in a P3.b once P0/P1 are battle-tested.
```
