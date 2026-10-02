# The AX.25 stack

This page describes the connected-mode data-link layer in `@aprscaching/ax25`, for contributors who change it
or build on it. Running a node or BBS on top of it is under
[Packet: BBS & NET/ROM node](../run/radios/packet-node.md).

## Design

The stack is a pure, event-driven AX.25 v2.2 (LAPB-derived) state machine. It does no I/O and has no real
timers, so every transition is testable and it behaves the same on every runtime. The ingest box runs it over
its KISS TNC or an AXUDP port (`apps/ingest/src/connected.ts`).

## What it implements

- **SABM/UA** connect and accept, **DISC/UA** release, DM, and FRMR recovery.
- **I-frame** transfer with windowing and the V(S), V(R) and V(A) counters.
- Supervisory **RR**, **RNR** and **REJ**, and **SREJ** selective reject with a receive buffer.
- **Modulo-128 (SABME)** extended-window connects, with 7-bit sequence numbers for high-throughput links.
- **T1** retransmission with **N2** retries, **T3** idle keepalive, and the poll/final timer-recovery cycle.

## Defaults

| Parameter | Default |
|---|---|
| `t1` | 3 s |
| `t3` | 30 s |
| `n2` | 10 |
| Window | 4 |
| Modulo | 8 |

The modulus is chosen for an outgoing connect and adopted from the peer's SABM or SABME on an incoming one.
SREJ is opt-in per link.

## INP3 routing

The NET/ROM node's INP3 support ([INP3 routing](../run/radios/packet-node.md#inp3-routing)) works this way on
the wire:

- A neighbour's routes arrive in a directed RIF: an I-frame with the `0xFF` info byte addressed to this node,
  never flooded to `NODES`.
- Latency comes from **L3RTT** probes: a NET/ROM layer-4 frame to the `L3RTT` pseudo-destination, which the
  neighbour echoes back. Samples are smoothed as `srtt' = (7·srtt + rtt) / 8`, and a route's `tt` is half the
  smoothed round trip.

## How it is tested

The state machine is unit-tested in `packages/ax25` and interop-tested over AXUDP against real packet software
([Interop against real packet software](testing.md#interop-against-real-packet-software)). Behaviour on a real
radio is checked when a station is deployed; that item is open in
[`TODO.md`](https://github.com/apachler/aprscaching/blob/dev/TODO.md).

## Next

- [Packet: BBS & NET/ROM node](../run/radios/packet-node.md): the node and BBS that run on the stack.
- [Testing & verification](testing.md): the suites that cover it.
