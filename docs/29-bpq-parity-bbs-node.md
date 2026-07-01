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

## Deferred (out of scope this pass)
Winlink/RMS gateway, chat/conference node, HF/Pactor, telnet node access, modulo-128 / SREJ, DAMA,
Dijkstra auto-routing, B2 (RMS-only).
