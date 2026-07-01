# BPQ-parity: BBS + NET/ROM node + digipeater over RF

Reference-implementation study of **G8BPQ / BPQ32 / LinBPQ** (John Wiseman) and the plan to reach
mission-fit parity. We do **not** port BPQ (it's a monolithic C node/switch/BBS running on the
operator's box); we **reimplement from the open specs** — the NET/ROM protocol, the FBB forwarding
protocol, MBL/RLI, AXIP/AXUDP — into our pure cores + operator-local ingest + cloud store, keeping
our rules: **RF ≠ trust** (a BBS/node never touches the A/B/C find tiers), **ingest-locality**
(connected-mode sessions run on the operator's own equipment), and our signed federation for our
own instances.

## Decisions (resolved via Q&A)
- **Scope:** node + BBS + digipeater parity. **Reject/defer** Winlink/RMS, chat/conference, HF/300-baud.
- **Interop posture:** **bridge** — real FBB forwarding to external BPQ/FBB BBSes over RF/AXUDP, **and**
  keep our signed-HTTP federation between our own instances. A gateway bridges the two worlds.
- **Locality:** the connected-mode BBS/node **session server runs in `apps/ingest`** (like BPQ); the
  cloud gateway is the message store + federation.
- **FBB wire:** **ASCII MBL/RLI + FBB-ASCII first** (interoperable, no compression); B0/B1 LZHUF as a
  fast-follow.
- **Config home:** sysop forwarding-partner + node params under **Settings → Connections & sources /
  Network** (consistent with the workbench-is-a-launcher reorg). The node/BBS stay Workbench *apps*
  for operation.

## What BPQ32/LinBPQ is
One process bundles: a NET/ROM **switch/node** (≤32 ports, NODES broadcasts, routes, aliases,
quality, cross-port), **AX.25 L2** over KISS/JKISS/BPQKISS + **AXIP/AXUDP** + telnet, **BPQMail**
(P/B/T messages, list/read/send/kill, BIDs, MBL/RLI + FBB compressed forwarding, hierarchical
`TO@AT` routing, White Pages), an **APRS digipeater/IGate** (no APRS client), a **chat/conference
server**, an **RMS/Winlink gateway**, and a **web management UI**.

## Current state (what we already have — P1–P4)
Pure, tested cores + gateway surface; the gaps are all at the **RF-wiring** layer.
- **AX.25 LAPB (mod-8):** `packages/ax25` — SABM/UA, I-frames + windowing, T1/T3, RR/RNR/REJ. (mod-128, SREJ deferred.)
- **FBB BBS interpreter:** `packages/packet/src/bbs.ts` — L/LA/LB/LM/LL, R, S/SP/SB/ST, SR (threaded), K, X, H, I, B; P/B/T; BID `id_instance`; `MessageStore` interface. Gateway `bbs.ts` + web `BbsPanel.tsx`.
- **NET/ROM table + node CLI:** `packages/packet/src/netrom.ts` — `NodesTable` (learn/decay/lookup, route reversal), `NodeSession` (Nodes/Routes/Connect/Users/MHeard/CQ/Info/Bye). Gateway `node.ts`, `netrom_nodes`/`node_mheard` (migration 0038). **Missing:** the L3/L4 wire codec, NODES broadcast TX, L4 circuits.
- **Forwarding core:** `packages/packet/src/forward.ts` — hierarchical `TO@AT` parse, longest-prefix routing, FB proposal build + FS verdict parse. Migration 0037 `bbs_forward_rules`; `white_pages` table + lookup/learn. Transport enum `rf-fbb | ip-fed | axip` (only `ip-fed` = signed bulletin federation is live).
- **Digipeater:** `apps/ingest/src/digipeater.ts` — UI/WIDEn-N only (live). **Missing:** connected-mode digi.
- **Terminal:** `packages/packet/src/session.ts` multi-channel core (used by the browser packet terminal).

## Wire formats (from the open specs — the reference we build to)

### NET/ROM (F2) — *The NET/ROM Protocol* (inter-node HDLC)
- Inter-node frame = AX.25 header **PID `0xCF`** + **15-byte network header** + **5-byte transport header**.
  - Network header: Origin-node call (7, AX.25 shifted) · Dest-node call (7, shifted, EOA) · Time-to-Live (1).
  - Transport header: Circuit Index · Circuit ID · TX Seq · RX Seq · Opcode&Flags.
- L4 opcodes: **1** ConnReq · **2** ConnAck · **3** DiscReq · **4** DiscAck · **5** Info · **6** InfoAck.
  Flags: choke `0x80`, NAK `0x40`, more-follows `0x20`. Info fragment max **236 bytes** (256 − 20 hdr).
  ConnReq carries proposed window + originating user/node calls; ConnAck high-bit = refuse, echoes accepted window.
- **NODES broadcast** = AX.25 **UI** frame to dest `NODES`, PID `0xCF`, info: signature `0xFF` + sender
  6-byte mnemonic, then per destination { dest call(7) · dest mnemonic(6) · best-quality neighbor call(7) ·
  best-quality(1) }, up to **11 per UI frame**.
- Route maths: on receiving a broadcast, `routeQuality = (broadcastQuality × pathQuality + 128) / 256`;
  keep **top-3** routes/dest; obsolescence init **6**, decrement each broadcast period (~hourly), purge at 0;
  `NODES+`/`NODES-` manual add/remove; obsolescence 0 = **locked** (never auto-updated). Trivial loop → quality 0.

### FBB forwarding (F4) — F6FBB protocol + BPQMail
- SID advertises capability (`[...-B1FHM…]`). All F-lines start in column 1, CR-terminated.
- **Proposal** (≤5 per block): `FB <P|B|T> <TO> <@AT> <FROM> <BID> <size>` … then `F>`.
  Example: `FB P F6FBB FC1GHV.FFPC.FRA.EU FC1MVP 24657_F6FBB 1345`.
- **Response**: `FS ±=…` — one char per proposal: `+` accept · `-` reject · `=` defer/already-held.
- Then the accepted messages stream as a block; **reverse forwarding** flips send direction after each block.
- Binary compressed **B0/B1** use **LZHUF**; **B1** adds restart + corruption checks; B2 = RMS only.
- `MSGTYPES P/T/B/R+sizes` negotiates what each side sends (passed to the peer if it's BPQ).
- Per-partner config: HA, connect script (`C NODE1` / `C 3 BBSCALL`), interval, UTC time-bands, request-reverse,
  max block size, max send/receive size, alias list. White Pages: `I <CALL>` → HomeBBS; learned from mail.

### AXIP/AXUDP (F5)
- **AXUDP** = raw AX.25 frame inside a UDP datagram (default port **93**); ported → NAT-friendly, multiple
  nodes per public IP. **AXIP** = AX.25 in IP (proto 93), portless (one node per IP). AXUDP preferred.
  These links carry NET/ROM crosslinks and FBB forwarding just like real RF.

## Implementation plan (F1–F5)

**F1 — Operator-local connected-mode session server** (`apps/ingest`)
- `src/sessionServer.ts`: on inbound SABM to our BBS/node SSIDs, spin a `ConnectedLink` (`packages/ax25`)
  bound to a `BbsSession`/`NodeSession` (`packages/packet`); pump KISS RX→link→session→link→KISS TX.
- `GatewayStore` adapter implementing the `MessageStore`/nodes interfaces over the gateway REST (store
  stays in the cloud; sessions stay on the box). Config: which SSIDs answer as BBS/node/digi.

**F2 — NET/ROM L3/L4** (pure `packages/packet` + ingest + gateway)
- New pure `netrom-wire.ts` (network+transport header + NODES codecs) and `netrom-circuit.ts` (L4
  sliding-window state machine: choke/NAK/more-follows, 236-B fragment/reassemble). Unit-tested round-trips.
- Extend `NodesTable` with the exact quality formula + obsolescence/locking + top-3. ingest: periodic NODES
  TX + inbound consume; L4 circuit routing (connect *through* the node).

**F3 — Connected-mode digipeater** (`apps/ingest/src/digipeater.ts`)
- Repeat any AX.25 frame whose next unconsumed via-hop is our call/alias (set H-bit), cross-port, with a
  viscous-delay option + per-port/alias config. (UI-digi already exists.)

**F4 — FBB forwarding partner** (pure `packages/packet` + ingest + gateway)
- Extend `forward.ts` into a full FBB session codec (SID, `FB…/F>`, `FS`, block transfer, reverse forwarding,
  `MSGTYPES`); ASCII first, then `lzhuf.ts` for B0/B1. Reuse the existing FB/FS codec + hierarchical parser.
- Migration `bbs_partners` (call, ha, connect_script, interval, timebands, request_reverse, msgtypes,
  max_block, proto, enabled) extending `bbs_forward_rules`.
- ingest forwarding scheduler: on interval/timeband, connect through nodes to the partner, run the codec,
  pull outbound / push inbound to the gateway (BID dedup already there); `learnWhitePages()` on inbound P-mail.
- **Bridge:** signed federation stays for our own instances; `rf-fbb`/`axudp` is the external leg. Sysop
  partner CRUD in gateway `forward.ts` (Settings → Network).

**F5 — AXIP/AXUDP transport** (`apps/ingest/src/axudp.ts`)
- A UDP socket (port 93) presenting AX.25 frames as a KISS-equivalent port so NET/ROM crosslinks *and* FBB
  forwarding run over the Internet (the bridge's internet leg). Reserve `amateurEndpoint` per docs/22.

## Invariants (MUST hold)
- **RF ≠ trust:** none of F1–F5 touches `verify.ts` or the A/B/C find tiers — a BBS/node is workbench.
- **Ingest-locality:** connected-mode sessions run on the operator's own box (`apps/ingest`) or browser RF;
  never cloud-only.
- **Pure cores stay pure + tested:** all wire codecs + state machines land in `packages/*` with unit tests,
  zero I/O, tri-runtime-clean.
- **Licensing:** reimplemented from open specs (NET/ROM, FBB, MBL/RLI, AXIP/AXUDP); `packages/*` stay MIT.

## Progress (pure cores + product wiring landed)
- **F1 (session glue + server):** `packages/packet/src/link-app.ts` (`LineApp` + `serveApp` binding a
  connected link to a line app) + `loopback.ts` (`VirtualClock` + deferred `LoopbackChannel`). Built on
  it, `session-server.ts` `SessionServer` — the "answer a connect" half: routes inbound frames to per-
  caller sessions, stands a fresh `BbsSession`/`NodeSession` up on an inbound SABM to a service SSID,
  cleans up on disconnect, enforces `maxSessions`, and supports an **async app factory** (warm-up) so a
  service can load state before greeting. Unit-tested end-to-end (a client link connects in and drives
  L/R/B over the deferred bridge). Ingest wires the **NODE** (live-table `NodeStore`: Nodes/Routes/Users/
  MHeard/Info/CQ) and the **BBS** services over KISS.
- **BBS inbound store:** `cached-bbs-store.ts` `CachedBbsStore` — a synchronous `MessageStore` over an
  async backend: loads the caller's per-session snapshot once at connect (also the access boundary — a
  connected user can only read their own personal mail + bulletins), serves list/read synchronously,
  posts/kills optimistically + writes through. Unit-tested. Gateway `/api/bbs/session` (per-caller
  snapshot) + `/api/bbs/kill` (owner-gated), both `x-ingest-secret` gated, tri-runtime + live-smoked
  (private mail excluded, kill owner-only). A station can now connect **into** our BBS over RF.
- **F2 (NET/ROM wire + circuit):** `netrom-wire.ts` (network+transport header + NODES broadcast codec,
  quality formula) and `netrom-circuit.ts` (L4 sliding-window state machine: ConnReq/ConnAck + window
  negotiation, DiscReq/DiscAck, in-order Info with cumulative InfoAck, 236-byte fragment/reassemble
  via more-follows, choke). Unit-tested over the deferred-queue loopback.
- **F2 node (ingest):** `netrom-node.ts` `NetromNode` — the routing engine: learns routes from heard NODES
  broadcasts (quality = combineQuality(advertised, path), obsolescence init 6 with decay, locked routes
  survive), builds our top-N NODES broadcast, picks the best next hop. Unit-tested. Ingest
  `netromnode.ts` `NetromNodeRunner` drives it over KISS (periodic UI→"NODES" TX + inbound consume +
  gateway node-table mirror).
- **F2 connect-through:** `serveApp` gains a relay mode + `onConnect`; `nodeConnectThrough(node, dial)`
  resolves the best route on `C <dest>` and splices the inbound user link to an onward L4 circuit
  (transparent byte relay; no-route → tells the user; far close → back to the node prompt). Unit-tested
  end-to-end over loopback against a real `NetromCircuit` echo peer. Ingest `NetromNodeRunner.dialer` opens
  a real `NetromCircuit` over KISS (network-header-framed NETROM UI to the neighbour) + demuxes inbound
  transport packets. **Validate-at-deploy:** the onward RF leg + multi-circuit demux (needs a live neighbour).
- **F2 switch (L3 transit):** `netrom-switch.ts` `routeNetrom(pkt, node, me)` — the node's switch decision:
  deliver locally, transit-forward toward the destination (TTL-1), or drop (ttl / no-route / self-loop).
  Unit-tested. `NetromCircuit` exposes `localIndex`/`localId` so the ingest demuxes inbound transport
  packets to the owning circuit by `(index,id)`. `parseConnectScript` turns a BPQ `C [port] <call>` script
  into hops (the sequencer that drives them is the radio leg). Ingest `onRaw` runs every directed NET/ROM
  frame through the switch (local → demux, transit → re-frame to the neighbour over KISS, drop → log).
- **F2 L4 inbound session:** the AX.25 line-driver core is extracted to `makeLineDriver` (shared by
  `serveApp`); `serveNetromApp` binds a `LineApp` to an accepting `NetromCircuit`, so a station connecting
  a NET/ROM *circuit* to us (from across the network, multi-hop) reaches the node CLI/BBS with greeting +
  commands + connect-through. Unit-tested end-to-end over a circuit loopback. Ingest `NetromNodeRunner`
  accepts an inbound ConnReq (`acceptInbound`) and routes replies to the reverse-path neighbour.
- **F2 connect sequencer:** `ConnectSequencer` drives a multi-hop connect script — issues `C <call>` per
  hop, watches for the node's "Connected to …" confirmation, signals ready after the last hop (or fails on
  busy). Unit-tested. Ingest `kissForwardLink` connects the AX.25 link to the first hop then sequences the
  rest before the FBB session starts.
- **F3 connected digi:** AX.25 codec now round-trips the digi H-bit (`digisRepeated`); `digipeatAx25`
  (pure, unit-tested) repeats ANY frame type whose next un-repeated via-hop is our call/alias (sets the
  H-bit). Ingest `ConnectedDigipeater` (KISS `onRaw`, dedup + viscous delay) relays NET/ROM + FBB through
  us. **Validate-at-deploy** on real RF.
- **F5 AXUDP port:** `axudp.ts` gains `AxudpPort` — a bidirectional KISS-equivalent transport over UDP
  (`sendFrame` to peers + `onRaw`/`onFrame`), so NET/ROM crosslinks *and* FBB run over the Internet leg;
  the RX-only `AxudpListener` (Tier-C ingest) stays. Tunnelled frames remain Tier C (never first-party).
  **Validate-at-deploy:** cross-port routing of the node/digi over the AXUDP peer.
- **F4 (FBB forwarding):** `fbb-session.ts` (SID → `FB…/F>` proposal → `FS` verdicts → block transfer →
  reverse forwarding → `FF`/`FQ`) driven headlessly over the loopback; BID dedup. `fbb-forward.ts`
  (`FbbForwarder`) wraps it as a byte-stream driver (CR framing + line buffering) for a real link.
  Product wiring: migration `0040_bbs_partners` + gateway `forward.ts` sysop partner CRUD
  (`normalizePartner` + `/api/bbs/partners`) + Settings → Network "Forwarding partners" UI.
- **F4 scheduler (ingest):** `apps/ingest/src/forwarder.ts` `BbsForwarder` — on an interval it polls the
  gateway for partners, picks the due ones (`forward-schedule.ts` `partnerDue`: interval + UTC time-bands,
  unit-tested), and per partner runs an FBB session over an injectable `ForwardLink`, bridging the gateway
  **forwarding pool** (migration `0041_bbs_forward_log`; `/api/bbs/forward/pool` pulls outbound routed to
  that partner via White-Pages + rules, `/inbound` stores received mail BID-deduped, `/sent` records what
  was forwarded — all `x-ingest-secret` gated, tri-runtime, live-smoked). The scheduler brain
  (`fbb-scheduler.ts` `BbsForwarder`, injectable `ForwardApi` + `ForwardLink`) is unit-tested **end-to-end
  over a loopback** — our pool → partner inbox, partner's reply → gateway `/inbound`, `markSent` reconciled,
  due-partner filtering (rf-fbb only, interval-gated). The ingest supplies the fetch `GatewayApi` +
  `kissForwardLink` (a real AX.25 `ConnectedLink` over KISS-TCP). **Validate-at-deploy:** multi-hop connect
  scripts (`C NODE1` → `C 3 DB0XYZ`), AXUDP partners, and LZHUF B0/B1 compression.

## Validate-at-deploy vs. genuinely blocked
Everything whose **logic** can be exercised over the loopback is built + tested: the FBB codec + scheduler,
the NET/ROM wire + circuit + node + connect-through, the connected-mode session server, and the inbound
BBS store. What remains is either a **real-radio leg** (KISS timing, a live neighbour for connect-through /
multi-hop / multi-circuit demux, an AXUDP peer) or **byte-exact FBB interop** — both need on-air testing,
not more code.

**LZHUF B0/B1** is the one item deliberately *not* built: its correctness *is* byte-exact compatibility
with FBB's fixed Huffman/position tables, which a round-trip test cannot prove (it only checks internal
consistency) and whose ~128 table constants are silently error-prone. Building it would ship intricate
bit-twiddling whose test gives false assurance — so it stays a documented follow-on to validate against a
real FBB partner, not a headless build. ASCII FBB forwarding is fully interoperable without it.

## Status matrix (what's built, tested, and what each still needs)

| Capability | Pure core (tested) | Product wiring | Still needs |
|---|---|---|---|
| AX.25 v2.2 connected link | `packages/ax25` `link.ts` ✅ | — | on-air T1/T3 tuning |
| KISS framing + TX/RX | `@aprsweb/aprs` kiss ✅ | `apps/ingest/kiss.ts` (`onRaw`, `sendFrame`) ✅ | a real TNC/radio |
| Connected-mode digi | `digipeatAx25` (H-bit) ✅ | `ConnectedDigipeater` ✅ | RF; viscous-cancel (follow-on) |
| Session server (answer connects) | `SessionServer` + `serveApp` ✅ | NODE + BBS services ✅ | RF |
| BBS command interpreter | `bbs.ts` `BbsSession` ✅ | gateway `/api/bbs/session`,`/kill` ✅ | RF |
| BBS inbound store | `CachedBbsStore` ✅ | `gatewayBbsBackend` ✅ | RF; snapshot-refresh cadence tuning |
| NET/ROM L3/L4 codec | `netrom-wire.ts` ✅ | — | — |
| NET/ROM L4 circuit | `netrom-circuit.ts` ✅ | dialer over KISS ✅ | a live neighbour |
| NODES table + broadcast | `netrom-node.ts` ✅ | `NetromNodeRunner` (TX/consume) ✅ | RF |
| L3 transit switch | `routeNetrom` ✅ | `onRaw` → switch ✅ | neighbour TX |
| Connect-through | `nodeConnectThrough` ✅ | `NetromNodeRunner.dialer` ✅ | neighbour; multi-circuit demux is minimal |
| L4 inbound session | `serveNetromApp` + `makeLineDriver` ✅ | `NetromNodeRunner.acceptInbound` ✅ | a live neighbour |
| Connect-script + sequencer | `parseConnectScript`,`ConnectSequencer` ✅ | `kissForwardLink` multi-hop ✅ | the node prompts' exact wording (tune the regex) |
| FBB forwarding (ASCII) | `fbb-session.ts`,`fbb-forward.ts` ✅ | scheduler + pool ✅ | a real FBB partner |
| FBB scheduler | `BbsForwarder` (e2e loopback) ✅ | `GatewayApi`+`kissForwardLink` ✅ | RF |
| AXUDP transport | — | `AxudpPort` (bidir) ✅ | a peer + cross-port routing |
| FBB binary B0/B1 | ✗ (see below) | — | LZHUF + a real FBB partner |

**Headlessly-buildable follow-ons still open** (do NOT need RF): **viscous-digi cancellation** (cancel a
pending repeat when the frame is heard already-digied by a better-placed digi); NODES **worst-quality
pruning / obsolescence broadcast threshold** (only re-advertise routes above a threshold, evict the worst
when the table is full). Both are small; everything else headlessly-testable in the F1–F5 node/BBS/forward
path is now built (incl. the L4 inbound session server and the multi-hop connect sequencer).

**Deliberately not built — LZHUF B0/B1.** Its correctness *is* byte-exact compatibility with FBB's fixed
Huffman/position tables, which a round-trip test cannot prove (it only checks internal consistency) and
whose ~128 constants are silently error-prone. A headless build would ship intricate bit-twiddling with a
false-assurance test — so it stays a follow-on to validate against a real FBB. ASCII FBB is fully
interoperable without it.

## RF bring-up guide (implementing the deploy-gated legs)

Everything below is *wired and unit-tested*; these steps light it up on real hardware and verify it.
Recommended kit: a KISS TNC over TCP (Direwolf, or a NinoTNC/Mobilinkd/TH-D75 in KISS) reachable at
`KISS_TNC_HOST:KISS_TNC_PORT`. The ingest is operator-local (`.claude/rules/ingest-locality.md`).

**0. Common setup.** Run `apps/ingest` on the operator box with `INGEST_URL` → your gateway and
`INGEST_SECRET` matching it. Point `KISS_TNC_HOST`/`KISS_TNC_PORT` at the TNC. Confirm `[kiss] connected`
and that RX frames appear (existing APRS path). All connected-mode features hang off `KissTnc.onRaw`
(inbound raw AX.25) and `KissTnc.sendFrame` (full-frame TX) — already in place.

**1. Connected-mode digipeater (F3).** Set `DIGI_CALL` + `DIGI_CONNECTED=1` (optional `DIGI_VISCOUS_MS`).
Verify: from a second station, send a frame routed `via YOURCALL`; confirm it's repeated with the H-bit
set (watch the monitor). `digipeatAx25` already decides; only TX timing is new. *Add viscous-cancel* if
you run parallel digis (cancel the pending repeat on hearing the frame already digied).

**2. Inbound BBS / node session server (F1/F2).** Set `BBS_NODE_CALL` (e.g. `OE8APR-1`) and/or
`NETROM_CALL` + `NETROM_ALIAS`. Connect to that SSID by **AX.25** from another station: you should get the
greeting, then drive `L`/`R n`/`S`/`B` (BBS) or `N`/`R`/`U`/`MH`/`I`/`C` (node). Connect by a **NET/ROM
circuit** (from across the network) and the same node CLI answers via `serveNetromApp` (`acceptInbound`).
The async BBS warm-up fetches `/api/bbs/session?call=` before greeting — confirm the peer's SABM-retransmit
window (T1×N2) exceeds one gateway round-trip (default 3 s × 10 is ample). Tune `SessionServer` `cfg`.

**3. NET/ROM node: NODES + transit switch (F2).** With `NETROM_CALL`/`NETROM_ALIAS` set, the runner
broadcasts NODES (default 5 min) and consumes neighbours'. Verify your node appears in a neighbour's NODES
list and vice-versa (`node.list()` mirrored to `/api/node/nodes`). For the **transit switch**, arrange
three nodes (A—us—B) so A's traffic for B routes through us; `routeNetrom` already decides forward/drop —
confirm the re-framed UI/NETROM frame goes out to the correct neighbour with TTL-1. Tune `NETROM_PATH_QUALITY`.

**4. Connect-through (F2).** From a station connected to our node, type `C <dest>` where `<dest>` is a
learned NODES entry via a live neighbour. `nodeConnectThrough` resolves the route and `NetromNodeRunner.dialer`
opens a real `NetromCircuit` to the neighbour; you should see `Connected to <dest>.` then transparent data.
The **single-circuit demux** is fine for one session; for concurrent connect-throughs, the inbound demux
keys on `(circuitIndex, circuitId)` — validate multi-circuit before advertising it. Multi-hop (`C NODE1`
then `C DB0XYZ`) needs the **sequencer** (build it against `parseConnectScript`, watching prompts).

**5. FBB forwarding to a real partner (F4).** In Settings → Network add a partner (call, HA, connect
script, interval, time-bands) and a routing rule (region → partner). Set `BBS_FORWARD=1`,
`BBS_FORWARD_CALL`. On the interval, `BbsForwarder` pulls `/api/bbs/forward/pool`, opens `kissForwardLink`
to the partner, runs the ASCII FBB exchange, and reconciles `/inbound` + `/sent`. Verify against a test
LinBPQ/FBB: watch the `[FBB-…]` SID handshake, `FB`/`F>`/`FS` lines, and BID dedup. A **multi-hop** partner
(connect script with >1 `C` line) routes through node(s): `kissForwardLink` connects to the first hop and
`ConnectSequencer` drives the rest — if your intermediate nodes phrase confirmations oddly, adjust the
sequencer's `connectedRe`/`failRe`. For **binary B0/B1**, implement `lzhuf.ts` and advertise `B1` in the
SID — validate the decompressed body against the partner.

**6. AXUDP crosslink (F5).** Set `AXUDP_PORT` + `AXUDP_PEERS=host:port,…`. `AxudpPort` presents the same
`onRaw`/`sendFrame` shape as KISS; route the node/digi/forwarder over it for HAMNET/Internet links. Cross-
port routing (a circuit that arrives on KISS and forwards over AXUDP) is the piece to validate — the
switch already emits a neighbour + frame; wire the TX side to pick the port by neighbour.

## Deferred (out of scope this pass)
Winlink/RMS gateway, chat/conference node, HF/Pactor, telnet node access, modulo-128 / SREJ, DAMA,
Dijkstra auto-routing, B2 (RMS-only).
