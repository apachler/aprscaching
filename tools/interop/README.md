# Interop test environment

Real-software interoperability tests for the packet stack: the NET/ROM node, the SID-gated FBB
BBS/forwarding, the AXUDP port, the APRS-IS client, the KISS TCP and AGWPE modem clients and the
RX-IGate, exercised against the programs actual partners run — LinBPQ, F6FBB, TheNetNode, JNOS,
aprsc, Direwolf, the kernel Linux AX.25 stack. Three tiers:

## Protocol × real-partner coverage

Every connection protocol the stack speaks, and which REAL partner implementation asserts it:

| protocol | real partner | asserted by | notes |
|---|---|---|---|
| AXUDP (AX.25-in-UDP + RFC 1226 CRC trailer) | LinBPQ (BPQAXIP), ax25ipd, JNOS, TNN | `bpq-loop`, `fbb-ax25`, `extra-peers` | trailer codec also unit-tested (`packages/ax25` axip-crc, ingest socket tests) |
| NET/ROM NODES broadcasts (both directions) | LinBPQ, TNN, JNOS | `bpq-loop`, `extra-peers` | acs learns the peer AND the peer learns ACS |
| AX.25 v2.2 connected mode (SABM/I-frames) | LinBPQ dials our node; we dial LinBPQ and F6FBB | `bpq-loop` (`C 1 OE1ACS-7`), `bpq-dial`, `fbb-ax25` | our LAPB answers a real initiator, and connects to BPQ's node and to FBB's BBS call through ax25ipd and the kernel stack |
| FBB forwarding (SID · FA/FB proposals · LZHUF B0/B1) | F6FBB over telnet, LinBPQ when its mail app runs | `fbb-forward`, `fbb-smoke` + explicit SKIP in `bpq-loop` | `fbb-forward` runs a full ASCII mail exchange both ways with F6FBB; the local loop asserts the session against our own responder every run |
| KISS TCP (FEND/FESC escaping · type byte · frame boundaries · UI both ways) | kernel Linux AX.25 (mkiss via `kissnetd`) | `kiss-kernel` | the kernel's mkiss CRC probe (SMACK, then FlexNet) is asserted as it arrives |
| AX.25 connected mode over KISS (SABM and SABME, I-frames, DISC) | kernel Linux AX.25 + `ax25d` | `kiss-kernel` | our LAPB initiator, modulo 8 and 128, against the kernel's |
| APRS-IS (login/passcode · server-side filter · stream) | aprsc (the core APRS-IS server) | `aprsis-loop` | beacon travels driver → aprsc → acs ingest → gateway API |
| KISS TCP (the ingest's KISS TNC client) | Direwolf | `direwolf-loop` | keys one Direwolf, hears the other, over Bell-202 1200 bd AFSK |
| AGWPE (`X` register · `k` raw monitor · `K` raw send) | Direwolf (AGW port :8000) | `direwolf-loop` | both directions against the KISS client, through the modems |
| RX-IGate (RF → APRS-IS, `qAR,<igate>`) | Direwolf + aprsc | `direwolf-loop` | the acs ingest gates what its Direwolf hears; an `RFONLY` path is held back |
| Telnet consoles | LinBPQ, F6FBB, TNN, JNOS | all drivers | reachability + banner/gate assertions |
| INP3 (RIF/L3RTT) | TNN (TheNet lineage) | `extra-peers` once the TNN leg is green | asserted stack-vs-stack in the local loop every run |

Not coverable in CI — validated at deploy on real hardware: Web Serial KISS / BLE-KISS /
Meshtastic over Web Serial / soundcard Bell-202 AFSK (browser + radio hardware), KISS TCP against
a hardware TNC (the protocol itself is asserted against the kernel stack and Direwolf above), AXIP
over raw IP proto 93 (needs CAP_NET_RAW both ends; the wire format is unit-tested and identical to
AXUDP's), and TAK/CoT output consumers. Weather (CWOP) rides the same APRS-IS protocol asserted above.

The remaining headless-coverable paths are the transport-conformance program in
[`TODO.md`](../../TODO.md); each leg landing updates this matrix. Active — the core transports:
KISS TCP vs kernel AX.25, APRS-IS vs aprsc, KISS TCP + AGWPE + the RX-IGate vs Direwolf, the FBB mail
exchange vs F6FBB and MeshCom's fixture conformance all run. Parked until after launch: WA8DED hostmode vs tfkiss,
AXIP vs ax25ipd, Meshtastic vs meshtasticd, the browser GPLSL drivers under Node, and the client-side
legs against the Station hub's servers. Every leg that already runs here stays.

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
| `fbb`    | F6FBB (Ubuntu `fbb` package) | kernel AX.25 ⇄ AXUDP via `ax25ipd` · telnet :6300 | privileged + host network + host `ax25`/`mkiss` |
| `tnn`    | TheNetNode | AXUDP · NET/ROM (TheNet lineage) | none |
| `jnos`   | JNOS 2.0 | AXUDP · NET/ROM · FBB fwd | none |
| `aprsc`  | aprsc (OH7LZB) | APRS-IS (login · filter · stream) | none |
| `ax25kernel` | kernel AX.25 (mkiss, `kissnetd`, `ax25d`) | KISS TCP :8001 · AX.25 connected mode | privileged + host network + host `ax25`/`mkiss` |

```bash
docker compose -f tools/interop/docker-compose.yml up -d acs linbpq
node tools/interop/tests/bpq-loop.mjs        # NODES both ways + forward into the BPQ BBS
sudo bash tools/interop/ax25kernel/load-modules.sh   # host, once — ax25 + mkiss, for both kernel tiers
ACS_AXUDP_PEERS=172.31.93.1:10093 docker compose -f tools/interop/docker-compose.yml --profile fbb up -d acs fbb
node tools/interop/tests/fbb-smoke.mjs        # xfbbd up + registration gate asserted
pnpm -C apps/ingest exec tsx ../../tools/interop/tests/fbb-ax25.mjs      # AX.25 connect over AXUDP, FBB's SID
pnpm -C apps/ingest exec tsx ../../tools/interop/tests/fbb-forward.mjs   # full mail exchange
docker compose -f tools/interop/docker-compose.yml --profile ax25kernel up -d --build ax25kernel
pnpm -C apps/ingest exec tsx ../../tools/interop/tests/kiss-kernel.mjs
```

The LinBPQ binary is freeware downloaded at image build (never redistributed here); FBB installs
from the Ubuntu archive; TNN and JNOS build from source. CI runs the container tiers in the
`interop` workflow (scheduled + manual dispatch — never the PR loop; peer downloads and kernel
modules are not PR-gating dependencies).

## 3. Modem transports — `direwolf/docker-compose.yml`

Two Direwolf modems joined by an audio cable, our full stack and aprsc, in the weekly `transports`
workflow (scheduled + manual dispatch, kept out of the `interop` run):

| service | software | role |
|---------|----------|------|
| `dw-a`  | Direwolf 1.7 (Ubuntu archive) | KISS TCP modem for the driver and the acs ingest |
| `dw-b`  | Direwolf 1.7 (Ubuntu archive) | AGWPE modem for the driver |
| `acs`   | our gateway + ingest | KISS TNC on `dw-a`, RX-IGate to `aprsc` |
| `aprsc` | aprsc (OH7LZB) | the APRS-IS server the IGate logs in to |

```bash
docker compose -p direwolf -f tools/interop/direwolf/docker-compose.yml up -d --build
pnpm -C apps/ingest exec tsx ../../tools/interop/tests/direwolf-loop.mjs
docker compose -p direwolf -f tools/interop/direwolf/docker-compose.yml down -v
```

Each Direwolf writes its transmit audio through ALSA's `file` plugin into UDP datagrams that the other
reads with `ADEVICE udp:7355`, so every frame is modulated and demodulated as Bell-202 1200 bd AFSK by
real modem code. The cable needs no kernel module and no privileges; `direwolf/start.sh` says why it is
used instead of `snd-aloop`. The driver runs the ingest's own `KissTnc` and `AgwpeTnc` classes against
the published ports (`DW_A_KISS_PORT` 38001, `DW_B_AGW_PORT` 38000, `DW_APRSC_FULLFEED_PORT` 38152,
`DW_ACS_PORT` 38787) and asserts:

- a frame keyed over KISS TCP on `dw-a` reaches the AGWPE client on `dw-b` with source, destination,
  path and information field intact, and a frame keyed over AGWPE on `dw-b` reaches the KISS client;
- a position keyed on `dw-b` is heard by `dw-a`, gated by the acs ingest's RX-IGate, and appears on
  aprsc's full feed as `OE9TST-9>APZACG,WIDE1-1,qAR,OE1ACS-10:…`;
- a frame whose path carries `RFONLY` is heard on RF but never reaches aprsc.

## What this catches

The local loop asserts two wire properties a real FBB/BPQ partner depends on: the BBS answers a
forwarding peer's SID with the forwarding protocol, never the human menu (the `FbbGatedBbs` responder
gate), and hierarchical to-addresses never put spaces into the space-delimited FB proposal line
(`fbbFromRow`, `FbbSession`).

## F6FBB runbook

The `fbb/` configs in this directory are the set tested against Ubuntu's `fbb` 7.011
package: `fbb.conf` + the telnet com in `port.sys` bring `xfbbd` up serving
`OE9FBB BBS. TELNET Access` on :6300 with the real `[FBB-7.0.11-AHMR$]` SID
(`tests/fbb-smoke.mjs` asserts this). First boot needs its data files created — `start.sh` answers
the interactive prompts with `yes Y` once, then serves.

FBB's telnet gate requires REGISTERED users: an unknown callsign is refused at the `Callsign :`
prompt (the smoke asserts that too), and a known one without modem access logs in read-only. On a
fresh data volume `start.sh` registers two users through the sysop console (`xfbbC -c -r -i OE1TST
-w password`, the `passwd.sys` default), with `EU <call>` and the flags set as `<flag> ON`:

| call | flags | password | role |
|---|---|---|---|
| `OE1TST` | `M` (modem/telnet access) | `interop2` | the sysop and the mailbox user the test reads as |
| `OE1ACS` | `B` (BBS), `M` | `interop1` | the aprscaching forwarding partner |

`EU` on an existing call asks `Delete <call> (Y/N) ?` first and on an unknown call `Create it
(Y/N) ?`; the console callsign itself exists from the moment the console connects. The container
log prints the edited user lines and `registered through xfbbC` when it is done.

`forward.sys` names `OE1ACS` as the partner on the telnet port (`P B`) and routes mail addressed
`@OE1ACS` to it; `bbs.sys` gives it slot 02. FBB never dials out: OE1ACS connects and FBB hands over
its queue by reverse forwarding in that session. FBB's forward-file parser rejects long or non-ASCII
comment lines (`Unknown command`), so the comments there stay short ASCII, and FBB defers (`FS =`) a
BID longer than 12 characters.

`tests/fbb-forward.mjs` drives our `FbbForwarder` (the session engine the ingest runs over AX.25)
over the telnet port as OE1ACS and asserts:

- FBB greets the partner with its SID, and accepts our `FB P` proposal (`FS +`); the message is
  delivered and dequeued.
- A message OE1TST wrote `@OE1ACS` comes back to us in the same session (reverse forwarding), and the
  session ends with `FQ`.
- A second session that proposes the same BID is refused (`FS -`) and sends nothing.
- OE1TST's mailbox lists the message (`LM`), and `R <n>` shows its body and BID.

### Kernel AX.25 and ax25ipd

`start.sh` attaches the kernel port `axudp` (`OE9FBB-1`) with `kissattach /dev/ptmx`, and `ax25ipd` opens the
pty slave kissattach prints and carries its KISS frames as AXUDP on udp :10093. xfbbd binds `OE9FBB-1` on that
port. The kernel path is required: without `/proc/net/ax25`, or when kissattach creates no `ax` device or
ax25ipd does not start, the container exits. `FBB_TELNET_ONLY=1` skips it on a host without the modules, and the
log says so.

The container runs on the host network for the same reason as `ax25kernel` below, so `ax25ipd.conf` names its
peers by IP: acs at `172.31.93.10`, which reaches ax25ipd at the compose network's gateway `172.31.93.1`
(`ACS_AXUDP_PEERS`), and the `fbb-ax25` dialer on the host at udp :10094 as `OE1PRB-2` (ax25ipd routes by
callsign and learns no addresses). The `fbb` CI job asserts the kernel leg three ways:

- the `ax` device exists on the runner and xfbbd's `OE9FBB-1` listener shows in `/proc/net/ax25`;
- the device counts received frames, the acs node's NET/ROM broadcasts arriving through ax25ipd;
- `tests/fbb-ax25.mjs` connects our LAPB initiator to `OE9FBB-1` and receives FBB's `[FBB-7.0.11-…$]` SID.

Over kernel AX.25 FBB auto-creates users on first connect, so this leg needs no registration.

## Kernel AX.25 runbook

The `ax25kernel/` container puts the kernel's mkiss line discipline behind KISS TCP the way a Linux node
does: `kissnetd` joins three pseudo-ttys — `kissattach` on one (port `kern`, `OE9KRN-1`), `socat` bridging one
to TCP :8001, and `axkit tap` logging every frame on the third, still escaped. `axkit mon` logs each frame the
kernel decoded or sent on its `ax` device, and `ax25d` runs `echo-svc` for a connect to `OE9KRN-2`: it greets
the caller by the call the kernel decoded, then echoes one I-frame. `axkit ui` sends UI frames through an
`AF_AX25` socket. `tests/kiss-kernel.mjs` drives our `KissTnc` against it and reads both logs.

The container needs the host network, since AF_AX25 sockets and AX.25 devices exist only in the initial
network namespace, and the `ax25` and `mkiss` modules on the host. `load-modules.sh` loads them, and builds
mkiss out of tree from the upstream source of the running kernel's version when the kernel ships without it
(the Azure kernels of GitHub's runners have `CONFIG_MKISS` unset). The container is ready about 35 s after start:
`kissnetd` stops relaying to a pty it read before the pty's slave was open, and retries such a pty after 30 idle
seconds.
