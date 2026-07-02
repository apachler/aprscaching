# RF-over-Internet Transports — Feature Benefit Analysis

**Project:** aprscaching.com (greenfield revival)
**Doc type:** Decision-support analysis (Claude Code foundation)
**Status:** Draft v4 — adds amateur-network reach comparison (§5A)
**Author context:** OE8APR / Vienna ingest region (`vie`)

---

## 1. Purpose

Decide, feature by feature, whether the aprscaching platform should integrate
**AXIP/AXUDP**, **HAMNET**, and **AMPRNet (44net)** — and if so, at which
architectural layer and with what relationship to the verification trust model.

This document is the reasoning substrate. It does **not** prescribe
implementation; it frames the decisions so Claude Code sessions can scaffold the
right abstractions and skip the wrong rabbit holes.

The single most important distinction it draws:

> **Transport convenience is not trust uplift.**
> A packet arriving over the internet carries no inherent proof it ever touched
> RF — regardless of whether the internet transport is APRS-IS, an AXIP link, or
> a HAMNET tunnel. Only infrastructure *you* control and can *attest for* yields
> Tier A corroboration.

---

## 1A. Decisions log — resolved 2026-06-25

Resolved via Q&A. Overall posture: **lean core, reserved seams** — build only the
first-class product now; design clean abstractions so every optional track plugs
in later without refactoring.

| # | Open point | Decision | Consequence |
|---|---|---|---|
| 1 | Own RF / HAMNET hardware? | **Maybe later — keep door open** | Tier A is *designed-for, not built*. Reserve provenance/attestation seam; defer RF infra. |
| 2 | BBS/messaging federation (AXIP)? | **Nice-to-have, later** | AXIP is Phase 2+, low priority. Reserve transport enum + provenance path; stub optional. |
| 3 | Geographic scope | **Global from day one** | Tier B (browser geolocation) is the global verification workhorse. No OE-only assumptions baked in. |
| 4 | 44net eligibility (non-commercial)? | **Yes — fully non-commercial** | 44net cleanly eligible. Keep amateur-facing surface non-commercial; revisit only if a paid tier ever appears. |
| 5 | 44net reachability gateway | **Design for it, defer build** | Reserve hybrid topology + `amateurEndpoint?` field. No PoP/subnet stood up yet. Connect-first when built. |
| 6 | Loop/re-injection policy (derived) | **Deferred with federation** | Pre-record the rule in the ADR (don't corroborate own egress; loop-prevent) so it survives. |

**Launch verification story (explicit).** At launch, Tier A effectively does not
exist anywhere (RF deferred + global scope). The strongest tier a find can earn
is **Tier B** (first-party app geolocation at log time); **Tier C** is the honest
uncorroborated fallback. The provenance seam ensures Tier A lights up later with
no rework. *This is a conscious choice — the launch trust model rests on Tier B +
honest Tier C badging.*

### Build now vs defer

- **Build now:** APRS-IS ingest · Tier B/C verification · the `provenance` object
  & transport enum (only `aprs-is` wired) · first-class APRS Caching product.
- **Reserve (design, don't build):** RF / Tier-A attestation · AXIP / BPQ
  federation · 44net gateway PoP + subnet.
- **Don't touch yet:** owned RF hardware · IPIP Mesh / BGP · paid tiers.

The single piece of "future" plumbing worth building into the core today is the
**provenance abstraction** — it serves the deferred RF/Tier-A track *and* keeps
AXIP/44net trust-neutral on arrival. Everything else is a reserved seam.

---

## 2. The three transports in one paragraph each

**AXIP / AXUDP** — Encapsulation of raw AX.25 frames inside IP/UDP (de-facto
UDP port 10093). This is the wire format that interlinks the global
**BPQ32/LinBPQ** node network over the internet: BBS forwarding, NET/ROM-style
routing, node-to-node and chat linking. It is a *peer-to-peer packet transport*,
not a feed you subscribe to. Joining it means your node becomes a participant in
an existing decades-old mesh. A frame received over AXIP has the same epistemic
status as a bare APRS-IS packet: it may or may not have originated on the air.

**HAMNET** — A high-speed (5/2.4 GHz) amateur **IP backbone** on 44net address
space, with internet VPN tunnels stitching regional islands together. Austria
(OE) runs one of the densest deployments. It is *IP, not AX.25 framing on the
wire* — packet services (BBS, APRS, node access, web) ride on top of it. Its
strategic value to us is regional and infrastructural: if we operate
HAMNET-connected RF receivers in OE, we control the RF→ingest chain and can
attest origin. That attestation is the only thing in this whole document that
produces genuine Tier A trust.

**AMPRNet / 44net** — The amateur IP allocation (the `44.x` space, ~12M
addresses stewarded by ARDC; note Amazon purchased a large block in 2019, so the
usable amateur range is smaller than the historic `44.0.0.0/8`). Crucially, 44net
addresses are **globally routable and directly reachable from the public
internet** — it is shared *public* address space, not a walled garden. It is
**decentralized** (no central backbone) and **non-commercial / license-gated**.
For us it is a **reachability layer**: a way to give our self-operated gateways
and peers stable, routable, amateur-namespaced addresses so the platform becomes
a native citizen of amateur networks. It remains **trust-neutral** — it changes
how we're *addressed and reached*, not whether a packet is *believable*. See §5A
for the full treatment.

---

## 3. Decision lens

Evaluate every candidate integration against four axes:

| Axis | Question |
|---|---|
| **Trust impact** | Does this provide *independent* corroboration, or is it just another internet transport (Tier C-equivalent)? |
| **Product value** | Does it serve APRS Caching (first-class) or only the workbench (supporting platform)? |
| **Cost / ops burden** | Does it fit Tier B (~$9–13/mo) / Tier C (~$25–40/mo), and does it require always-on infra or owned hardware? |
| **Regional fit** | Is the benefit global, or concentrated in OE where we have presence? |

**Hard rule carried over from the trust model:** any internet-sourced packet —
APRS-IS, AXIP, HAMNET-tunnelled — is excluded from corroboration *unless* it
arrives via a first-party receiving site we operate and attest for. No circular
corroboration; no transport laundering a packet into a higher tier.

---

## 4. Feature-by-transport matrix

Legend — **✅** clear benefit · **➖** marginal/conditional · **❌** no benefit or
actively harmful to the model · **⚠️** benefit but with a trust caveat.

| Platform feature | AXIP/AXUDP | HAMNET (self-operated RF) | AMPRNet/44net |
|---|---|---|---|
| **APRS Caching — find logging** | ❌ adds nothing; never gate logging | ➖ indirect (enables Tier A path below) | ❌ |
| **Verification — Tier A (RF-corroborated)** | ⚠️ only if *we* receive on RF and bridge; third-party AXIP frames give **no** uplift | ✅ **the** high-value case: owned OE receiver → attested RF origin | ➖ addressing for our own receivers only |
| **Verification — Tier B (app geolocation)** | ❌ orthogonal | ❌ orthogonal | ❌ orthogonal |
| **Verification — Tier C (IS-only)** | ⚠️ AXIP becomes another Tier C source; more volume, no more trust | ➖ same | ❌ |
| **Live map ingest** | ✅ additional packet sources beyond APRS-IS (esp. RF-local traffic not gated to IS) | ✅ low-latency regional OE feed | ➖ routing only |
| **Multi-transport RF ports** | ✅ natural fit — AXUDP is literally a port type | ✅ KISS-over-IP from HAMNET sites | ➖ |
| **Digipeater** | ➖ relevant only if we run an on-air digi | ✅ if we run OE RF infra | ➖ |
| **IGate** | ⚠️ we could egress to the BPQ mesh; mind loop/trust rules | ✅ HAMNET-side IGate = owned first-party source | ➖ |
| **BBS / messaging** | ✅ **strongest workbench case** — federate into the existing global packet BBS mesh | ✅ regional store-and-forward | ➖ endpoint addressing |
| **Weather sensors** | ➖ data could arrive via packet, but APRS-IS already covers this | ➖ | ❌ |
| **Outbox / APRS-IS announce** | ❌ keep announce on APRS-IS; do not multiply egress paths early | ❌ | ❌ |
| **Platform reachability (multi-network presence)** | ➖ node-mesh membership only | ✅ native reach for OE amateur users | ✅ **primary value** — routable amateur presence; reachable from other 44net/HAMNET-routed nets *if* routing is arranged |

---

## 5. Verification-model implications (the crux)

Map each transport onto the existing tiers explicitly so the engine's contract
stays clean.

- **Tier A (RF-corroborated)** requires *independent RF evidence*. The only
  candidate here that delivers it is **a receiver we own and operate** — whether
  its uplink to us is the public internet, a HAMNET tunnel, or AXUDP is
  irrelevant; what matters is that *our* site attests "heard on-air at
  time/place." HAMNET is the realistic vehicle for this in OE because the RF
  infrastructure and IP backbone already exist there.

- **Tier C (IS-only / uncorroborated)** is where *all third-party
  internet-sourced packets land*, including AXIP frames from someone else's BPQ
  node. Adding AXIP ingest **increases volume, not trust**. That can still be
  desirable (richer live map, more cache-find candidates to then corroborate via
  Tier B), but it must be badged honestly.

- **The spoofability parallel:** bare APRS-IS packets are spoofable via
  `qAC`/`qAX` injection; an AXIP frame is spoofable in exactly the same way one
  layer down — nothing in AX.25 framing proves air-time. The `qAR` vs `qAC/qAX`
  signal is our RF-vs-injected discriminator on the IS side; on the AXIP side
  there is no equivalent free signal, which is precisely why third-party AXIP
  cannot be promoted above Tier C.

**Engine design consequence:** the verification engine must consume a
**normalized `provenance` object**, never a raw transport. Provenance carries:
transport type, q-construct (where applicable), and — critically — a
*first-party-site attestation flag*. Tier A is reachable **only** when that flag
is set by infrastructure we control. This keeps "which transport" out of the
trust logic entirely.

---

## 5A. AMPRNet / 44Net as a reachability layer (deep dive)

Reading the 44Net wiki upgrades AMPRNet from "addressing plumbing" into a real
strategic option for the platform-reachability goal — *but only at the right
layer, and with eligibility strings attached.*

### What 44Net actually is

- **Globally-routable public address space.** 44net addresses are directly
  reachable from the public internet — this is what makes "addressable on amateur
  space" actually useful rather than a private overlay.
- **Decentralized.** No central backbone, router, or NOC. ARDC stewards the
  address space; independent operators bring it online through three *independent*
  methods that are **not automatically integrated with each other**.
- **Non-commercial and license-gated.** Eligibility generally requires an amateur
  license and a non-commercial purpose. This is a platform-level decision, not a
  technicality (see Open Questions).

### The three provisioning methods — and which fits us

| Method | What it is | Fit for aprscaching |
|---|---|---|
| **44Net Connect** | Managed WireGuard tunnel; one device / small net; minimal routing skill | **Easiest on-ramp.** Give a single gateway (a VPS, or the Fly.io `vie` host) a 44net address and a reachable PoP. Good for a first experiment. |
| **IPIP Mesh** | Community IP-in-IP overlay; nodes peer and exchange routes; transits shared gateways. Living descendant of classic AMPRNet. | **Most relevant for cross-network reach.** The natural path to being routed alongside other regional/club amateur networks. |
| **BGP-announced subnet** | Announce your own prefix; needs an ASN + upstream + facility | **Endgame.** Globally-routed, multi-homed, you own routing policy. Heavyweight — revisit only if the platform grows its own infra. |

Two wiki facts hard-constrain the design:

- **Subnets are tied to their provisioning method — there is no porting between
  Connect / Mesh / BGP.** Choose deliberately. (You *can* run subnets in multiple
  systems simultaneously, and multiple subnets behind one router you operate.)
- **Reachability is not automatic across methods.** Connectivity "emerges from
  cooperation between participants rather than centralized control." Holding an
  allocation does not, by itself, put you on anyone else's network.

### The subnet-reservation idea, assessed

The instinct — reserve a subnet, give each peer a 44net IP, become a citizen of
amateur networks — is **sound for the right layer**. Two clarifications make it
workable:

**1. It applies to the self-operated gateway/peer layer, NOT the Cloudflare
front-end.** Cloudflare Workers / Pages / Durable Objects live on Cloudflare's
anycast; you cannot assign 44net IPs to them or announce 44net space through
them. The realistic topology is therefore **hybrid**:

- `app.aprscaching.com` → Cloudflare anycast → the default public **web channel**
  (browser/phone-app users, commercial internet). Unchanged.
- an **amateur PoP / 44net gateway** → a small always-on host holding a 44net
  address from your subnet, reverse-proxying the same API into amateur space and
  participating in the Mesh (or BGP later).
- **peers that are real stations / gateways** (RF sites, HAMNET boxes,
  self-hosters) get 44net IPs from your subnet via Connect and become natively
  addressable members of the aprscaching network. Browser/app users do *not* —
  they reach you over the web channel.

**2. HAMNET reachability is a routing relationship, not a freebie.** HAMNET (OE)
is itself built on 44net space with its own internal routing and gateways. A
properly-routed aprscaching 44net gateway *can* be reachable from HAMNET — but
you establish that route, most naturally by participating in the IPIP Mesh and/or
coordinating with the OE regional coordinator / HAMNET routing (BGP peering later
if it ever justifies it). A subnet alone does not place you on HAMNET.

### Which amateur networks the 44net strategy actually reaches

Not all "ham high-speed data" networks are reachable the same way. The three most
cited — HamWAN, Broadband-Hamnet/HSMM-Mesh, HAMNET — split on the one axis that
matters here: **addressing.**

| Network | Topology | Addressing | Geography / scale | Reach via our 44net strategy |
|---|---|---|---|---|
| **HAMNET** | Engineered PtP backbone + access | **44net-native** (IP-IP → migrating to BGP) | Europe / DACH; ~4,000 nodes (largest amateur IP net) | **Native** — primary reach target |
| **HamWAN** | Engineered cells (MikroTik NV2/TDMA) | **44net-native** | US Pacific NW; ~dozen sites | **Native**, but US-regional & small — *reference model*, not a reach target |
| **Broadband-Hamnet / HSMM-Mesh → AREDN** | Self-configuring mesh (OLSR → Babel) | **10.x mesh** auto-addressed; reaches 44net only via a gateway | US-dominant + global pockets; many small meshes | **Gateway-bridged only** — not natively joinable |

Status note: **Broadband-Hamnet (HSMM-Mesh) is effectively dormant** (site frozen
~2015, originally WRT54G firmware). It **forked into AREDN**, which is the active
successor and the mesh firmware actually in use today. Treat the middle column as
"→ AREDN."

**Conclusion for the deferred gateway:** "reachable from other amateur networks"
resolves to *HAMNET (native) · HamWAN (native) · AREDN (only via their gateway)*.

- **HAMNET is the network the deferred 44net gateway should target first** — it's
  44net-native, by far the largest, and on home turf (OE8). Peering path: IPIP
  Mesh and/or BGP, coordinated with ÖVSV.
- **HamWAN** is the same managed-44net pattern but US-regional; value to us is as
  an **architecture reference** if we ever build our own infra, not as reach.
- **AREDN** is best modeled as *a population of users behind gateways*, not a
  network we natively join. Its 10.x islands mean a 44net subnet does not reach
  AREDN users directly; where a mesh has an internet gateway, those users arrive
  over the normal web channel anyway. **No design change required** — just don't
  assume the subnet buys AREDN reach.

All three remain transport/addressing — **trust-neutral**, per §1A.

### Why it's still worth doing

At the gateway layer, 44net gives exactly the property the platform goal is
reaching for: a **stable, publicly-routable, amateur-namespaced presence that
amateur networks can reach natively**, complementing — not replacing — the
commercial web channel. You also get amateur-native DNS under `ampr.org`
(e.g. `aprscaching.ampr.org`, per-node hostnames), which reinforces the
platform-as-network-citizen identity.

### Trust note (unchanged)

Reachability on 44net is **still transport/addressing — trust-neutral.** A
request or packet arriving over 44net is no more corroborated than one over the
commercial internet. The Tier-A-only-from-first-party-RF rule stands without
modification.

---

## 6. Product vs platform split

- **APRS Caching (first-class):** benefits from these transports **only
  indirectly**, via (a) a richer live map and (b) the owned-RF Tier A path in OE.
  None of them should ever sit on the critical path of logging a find — the
  auth/verification-must-not-gate-logging rule extends here too.

- **Workbench (supporting platform):** this is where AXIP/AXUDP earns its keep.
  Letting our node *join the existing BPQ backbone* (BBS forwarding, node/chat
  linking) is a real network-effect feature for the ham-radio audience and is
  the most defensible reason to implement AXIP at all.

---

## 7. Cost & operational reality

| Integration | Always-on infra? | Owned hardware? | Fits which tier |
|---|---|---|---|
| AXIP/AXUDP listener | Yes (UDP socket on the ingest container) | No | Tier B — marginal added cost on existing Fly.io `vie` container |
| HAMNET self-operated RF | Yes | **Yes** (radio + HAMNET link) | Out of cloud-cost model — capex + site, not $/mo |
| AMPRNet endpoints/tunnels | Conditional | Only with above | Tier B/C — negligible unless tunneling |

The decisive cost question is **owned hardware**. AXIP and AMPRNet are software
that runs on infra we already have. HAMNET-for-Tier-A means physical RF presence
in OE — a different category of commitment, and the only one with real
trust payoff.

---

## 8. Recommendation (phased)

**Phase 1 — now (no change).**
Ship APRS-IS-only ingest as already designed. Do not add transports while the
core product and verification engine are still settling. Resist scope creep.

**Phase 2 — workbench federation (optional, medium effort).**
Add an **AXUDP listener** (UDP 10093) to `apps/ingest` behind a feature flag.
Purpose: let the aprscaching node participate in the BPQ backbone for
**BBS/messaging/node-link** features. Frames normalize into the same internal
packet contract and land at **Tier C** by default — explicitly excluded from
corroboration. Value is community/network-effect, not trust.

**Phase 3 — owned RF Tier A in OE (high value, high commitment).**
*If* we choose to operate HAMNET-connected receivers, wire them as **first-party
IGate sources** that set the attestation flag, unlocking genuine **Tier A**
corroboration for OE caches. This is the only path that improves verification
quality rather than just data volume.

**AMPRNet / 44Net — optional parallel reachability track (decision-gated).**
Distinct from the RF/Tier-A question. If we want the platform to be a native
citizen of amateur networks, the lightweight first step is: reserve a subnet and
stand up **one 44net gateway PoP via 44Net Connect**, reverse-proxying the
existing API into amateur space. Graduate to **IPIP Mesh** only when cross-network
reach (incl. HAMNET) becomes a concrete goal; **BGP** only if the platform grows
its own routed infra. Gated on the non-commercial eligibility decision below.
Trust-neutral throughout — never feeds the verification engine.

---

## 9. Open questions (need a decision before Phase 2/3)

> **Resolved 2026-06-25 — see §1A for the decision log.** The questions below are
> retained as the rationale record. Net result: lean core now, every optional
> track designed-for and deferred.

1. **Hardware intent** — do we plan to operate any owned RF / HAMNET gear, or
   stay cloud/software-only? This single answer gates whether Tier A is ever more
   than the existing browser-geolocation (Tier B) story.
2. **Is BBS/messaging federation a product goal**, or merely a nice-to-have? It's
   the main thing AXIP buys us.
3. **Geographic scope** — OE-first, or global from day one? Owned-RF Tier A is
   inherently OE-concentrated; the rest of the world stays Tier B/C.
4. **Loop / re-injection policy** — if we both ingest from and egress to the BPQ
   mesh, define the loop-prevention and we-don't-corroborate-our-own-egress rules
   up front (mirrors the existing announce-packet exclusion).
5. **44Net eligibility / non-commercial status** — 44net requires a non-commercial
   purpose and an amateur license. Can the platform commit to non-commercial
   operation for its amateur-facing surface? (The Tier B/C figures are internal
   *hosting-cost* targets, not a pricing model — but if a paid tier is ever on the
   table, that conflicts with 44net eligibility and must be reconciled.)
6. **Provisioning method** — if we pursue 44net, start with **44Net Connect** (one
   gateway) or go straight to **IPIP Mesh** (cross-network reach)? Recommendation:
   Connect first; Mesh when HAMNET reach is an actual requirement. Remember subnets
   are tied to their method and cannot be ported.

---

## 10. Concrete next steps for Claude Code

**Status (post-1.0 pass): all seven scaffolding tasks are BUILT.** (1) the `Transport` enum + (2) the
`provenance` object live in `packages/shared/src/packet.ts`; (3) the verify engine consumes `provenance`
only, Tier A gated solely on `firstPartyAttested` (`workers/gateway/src/provenance.ts` + `provenance.test.ts`,
incl. an explicit AXUDP-can-never-attest case); (4) the **AXUDP listener/port** is wired + feature-flagged
in `apps/ingest` (`axudp.ts` — the datagram→Tier-C-Packet normalize is now factored into the pure
`axudpToPacket` and unit-tested, so the "transport ≠ trust" invariant has a regression guard); (5) the ADR
is `docs/decisions/0001-transport-vs-trust.md`; (6) the hybrid-topology sketch is §5A above; (7) the
`amateurEndpoint?` seam is on the node model (`FED_AMATEUR_ENDPOINT`).

**AXIP too (Phase-2 seam, decision #2) is now built**, RX **and TX**, as `apps/ingest/src/axip.ts`: AX.25 in
**raw IP proto 93** (vs AXUDP's UDP 10093). RX (`AxipListener`, flag `AXIP_ENABLE`) strips the IPv4 header a
raw proto-93 socket delivers (`stripIpv4Header`) before decoding — its one genuinely distinct piece — then
`axipToPacket` normalises. TX + bidirectional crosslink is `AxipPort` (flag `AXIP_PEERS`): `sendFrame`
egresses a full AX.25 frame to each peer via `frameToAxip` (a bare frame — the kernel builds the IP header),
and inbound also feeds `onRaw`/`onFrame` so NET/ROM + FBB run over the AXIP leg — the raw-IP twin of
`AxudpPort`. All the pure codec (strip/normalize/encode + peer parse) is unit-tested incl. TX round-trips;
only the raw-socket bind/send (optional `raw-socket`, `CAP_NET_RAW`) is validate-at-deploy.

**Both transports are symmetric now:** AXUDP `AxudpPort.sendFrame`/`frameToAxudp` (UDP 10093) and AXIP
`AxipPort.sendFrame`/`frameToAxip` (IP proto 93). TX is **operator-config-gated** (the sysop sets
`AXUDP_PEERS`/`AXIP_PEERS`) internet node-transport for NET/ROM crosslinks + FBB forwarding — NOT on-air
keying, so the H5 verified-callsign RF-TX gate (the box tx path) stays a separate concern. Egressed frames
land at Tier C (`port:"axudp"`/`"axip"`, `firstPartyAttested:false`), same transport-≠-trust rule as RX;
loop-prevention on ingest↔egress (decision #6) is still deferred with federation.

What remains is exactly the **explicitly-deferred, non-code** work: owned-RF Tier-A hardware, the 44net PoP/
subnet standup, IPIP Mesh / BGP — none built by design.

These are scaffolding tasks that keep options open without committing to any
transport prematurely:

1. **`packages/aprs` — define a `Transport`/`Source` enum** in the normalized
   packet contract: `aprs-is | axudp | axip | hamnet-kiss | first-party-rf`.
2. **Add a `provenance` object to the normalized packet** (Zod, in
   `packages/shared`): `{ transport, qConstruct?, firstPartyAttested: boolean,
   siteId?, heardAt? }`.
3. **Refactor the verification engine to consume `provenance` only** — Tier A
   gated solely on `firstPartyAttested === true`; transport type must never
   appear in trust branching.
4. **Stub an AXUDP listener module** in `apps/ingest` (UDP 10093), feature-flagged
   off, that decodes AX.25 → normalized packet → `provenance.transport = 'axudp'`,
   `firstPartyAttested = false`.
5. **Add a `docs/decisions/` ADR** capturing the transport-vs-trust rule so the
   exclusion principle survives future sessions.
6. **Sketch a `gateway/` concept (do not build yet)** — document the hybrid
   topology so it's reserved in the architecture: Cloudflare anycast web channel
   **+** an optional 44net PoP that reverse-proxies the same API into amateur
   space. Keep the front-end IP-agnostic so a 44net gateway can be added later
   without refactoring.
7. **Reserve an `amateurEndpoint?` field on the peer/node model** — so a node can
   optionally carry a 44net address + `ampr.org` hostname without coupling the
   serverless front-end to any IP space.

---

## Appendix — quick reference

| Term | One-line |
|---|---|
| AXIP / AXUDP | AX.25 frames tunnelled over IP/UDP (port 10093); interlinks the BPQ node mesh |
| BPQ32 / LinBPQ | The dominant packet-node software; forms the de-facto internet AX.25 backbone |
| HAMNET | Amateur high-speed IP backbone (44net), RF-linked + internet-tunnelled; dense in OE |
| AMPRNet / 44net | Amateur IP allocation; globally-routable public space stewarded by ARDC; decentralized |
| 44Net Connect | Managed WireGuard tunnel — easiest way to give one host/gateway a 44net address |
| IPIP Mesh | Community IP-in-IP overlay; nodes peer and exchange routes; path to cross-network reach |
| BGP-announced subnet | Self-announced prefix (needs ASN + upstream); globally-routed, autonomous |
| ampr.org DNS | Amateur-native naming under the 44net DNS (e.g. `aprscaching.ampr.org`) |
| q-construct | APRS-IS path token; `qAR` ≈ RF-originated, `qAC`/`qAX` ≈ injected — our RF discriminator |
| First-party attestation | A site *we* operate vouching "heard on-air here" — the only Tier A source |
