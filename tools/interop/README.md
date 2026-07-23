# Interop test environment

Real-software interoperability tests for the packet stack: the NET/ROM node, the SID-gated FBB
BBS/forwarding, the AXUDP port, and the APRS-IS client, exercised against the programs actual
partners run — LinBPQ, F6FBB, TheNetNode, JNOS, aprsc. Two tiers:

## Protocol × real-partner coverage

Every connection protocol the stack speaks, and which REAL partner implementation asserts it:

| protocol | real partner | asserted by | notes |
|---|---|---|---|
| AXUDP (AX.25-in-UDP + RFC 1226 CRC trailer) | LinBPQ (BPQAXIP), ax25ipd, JNOS, TNN | `bpq-loop`, `fbb-smoke`, `extra-peers` | trailer codec also unit-tested (`packages/ax25` axip-crc, ingest socket tests) |
| NET/ROM NODES broadcasts (both directions) | LinBPQ, TNN, JNOS | `bpq-loop`, `extra-peers` | acs learns the peer AND the peer learns ACS |
| AX.25 v2.2 connected mode (SABM/I-frames) | LinBPQ dials our node | `bpq-loop` (`C 1 OE1ACS-7`) | our LAPB answers a real initiator |
| FBB forwarding (SID · FA/FB proposals · LZHUF B0/B1) | F6FBB (kernel AX.25 leg), LinBPQ when its mail app runs | `fbb-smoke` + explicit SKIP in `bpq-loop` | the local loop asserts the full session against our own responder every run |
| APRS-IS (login/passcode · server-side filter · stream) | aprsc (the core APRS-IS server) | `aprsis-loop` | beacon travels driver → aprsc → acs ingest → gateway API |
| Telnet consoles | LinBPQ, F6FBB, TNN, JNOS | all drivers | reachability + banner/gate assertions |
| INP3 (RIF/L3RTT) | TNN (TheNet lineage) | `extra-peers` once the TNN leg is green | asserted stack-vs-stack in the local loop every run |

Not coverable in CI — validated at deploy on real hardware: Web Serial KISS / BLE-KISS /
Meshtastic over Web Serial / soundcard Bell-202 AFSK (browser + radio hardware), KISS TCP against
a hardware TNC, AXIP over raw IP proto 93 (needs CAP_NET_RAW both ends; the wire format is
unit-tested and identical to AXUDP's), and TAK/CoT output consumers. Weather (CWOP) rides the
same APRS-IS protocol asserted above.

The remaining headless-coverable paths — KISS TCP vs kernel AX.25, WA8DED hostmode vs tfkiss,
AGWPE + AFSK vs Direwolf, AXIP vs ax25ipd, CoT vs FreeTAKServer, Meshtastic vs meshtasticd, the
full FBB mail exchange, and the browser GPLSL drivers under Node — are the transport-conformance
program in [`TODO.md`](../../TODO.md); each leg landing updates this matrix.

## 1. Local loop — no Docker (`run-local-loop.sh`)

Two full aprscaching stacks (gateway + ingest) crosslinked over AXUDP on localhost:

```bash
bash tools/interop/run-local-loop.sh
```

Asserts NODES broadcasts learned in both directions and an FBB forwarding session (our initiator →
our SID-gated responder) carrying a message A→B over real AX.25 connected mode, BID-deduped. Runs
anywhere Node runs; CI runs it in the `interop` workflow before the containerized peers.

Debug tools: `probe-bbs.mjs` (dial any AXUDP BBS and run a no-traffic F-protocol exchange),
`probe-responder.mjs` (a log-everything responder to point our forwarder at).

## 2. Containerized peers — `docker-compose.yml`

| service  | software | speaks | privileges |
|----------|----------|--------|------------|
| `acs`    | our gateway + ingest | AXUDP · NET/ROM · FBB fwd | none |
| `linbpq` | G8BPQ LinBPQ | AXUDP · NET/ROM · FBB fwd (B1/B2 capable) | none |
| `fbb`    | F6FBB (Ubuntu `fbb` package) | kernel AX.25 ⇄ AXUDP via `ax25ipd` | privileged + host `modprobe ax25` |
| `tnn`    | TheNetNode | AXUDP · NET/ROM (TheNet lineage) | none |
| `jnos`   | JNOS 2.0 | AXUDP · NET/ROM · FBB fwd | none |
| `aprsc`  | aprsc (OH7LZB) | APRS-IS (login · filter · stream) | none |

```bash
docker compose -f tools/interop/docker-compose.yml up -d acs linbpq
node tools/interop/tests/bpq-loop.mjs        # NODES both ways + forward into the BPQ BBS
sudo modprobe ax25                            # host, once — then the FBB tier:
docker compose -f tools/interop/docker-compose.yml --profile fbb up -d
node tools/interop/tests/fbb-smoke.mjs        # xfbbd up + registration gate asserted
```

The LinBPQ binary is freeware downloaded at image build (never redistributed here); FBB installs
from the Ubuntu archive; TNN and JNOS build from source. CI runs the container tiers in the
`interop` workflow (scheduled + manual dispatch — never the PR loop; peer downloads and kernel
modules are not PR-gating dependencies).

## What this catches

The local loop already caught two wire bugs on its first run: the interactive BBS answering a
forwarding peer's SID with the human menu (fixed by the `FbbGatedBbs` responder gate), and
hierarchical to-addresses leaking spaces into the space-delimited FB proposal line (fixed in
`fbbFromRow` + hardened in `FbbSession`). A real FBB/BPQ partner would have hit both.

## F6FBB runbook (validated live in the sandbox)

The `fbb/` configs in this directory are the exact set validated against Ubuntu's `fbb` 7.011
package: `fbb.conf` + the telnet com in `port.sys` bring `xfbbd` up serving
`OE9FBB BBS. TELNET Access` on :6300 with the real `[FBB-7.0.11-AHMR$]` SID
(`tests/fbb-smoke.mjs` asserts this). First boot needs its data files created — `start.sh` answers
the interactive prompts with `yes Y` once, then serves.

FBB's telnet gate requires REGISTERED users: an unknown callsign is refused at the `Callsign :`
prompt (the smoke asserts that too). Registering the forwarding partner (`OE1ACS` + password +
BBS status) happens through the sysop console — `xfbbC -c -r` connects with full sysop rights —
and is the remaining step for the full telnet-forwarding driver; over kernel AX.25 (the CI path)
FBB auto-creates users on first connect, so the AXUDP/ax25ipd leg needs no registration.
