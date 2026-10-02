# The AX.25 stack

The data-link layer (`@aprscaching/ax25`) is a pure, event-driven AX.25 v2.2 (LAPB-derived) state machine — no
I/O and no real timers, so it is exhaustively testable and identical on every runtime. It implements:

- **SABM/UA** connect and accept, **DISC/UA** release, DM, and FRMR recovery;
- **I-frame** transfer with windowing and the V(S)/V(R)/V(A) counters;
- supervisory **RR / RNR / REJ**, and **SREJ** selective-reject with a receive buffer;
- **modulo-128 (SABME)** extended-window connects — 7-bit sequence numbers for high-throughput links;
- **T1** retransmission with **N2** retries, **T3** idle keepalive, and the poll/final timer-recovery cycle.

The modulus is chosen for an outgoing connect and adopted from the peer's SABM/SABME on an incoming one;
SREJ is opt-in per link. Defaults: `t1` 3 s, `t3` 30 s, `n2` 10, window 4, modulo 8. The ingest box runs the
state machine over its KISS TNC or an AXUDP port (`apps/ingest/src/connected.ts`). The stack is unit-tested
and interop-tested over AXUDP; behaviour on a real radio is validated at deploy, as tracked in
[`TODO.md`](https://github.com/apachler/aprscaching/blob/dev/TODO.md).

## Next

- [Packet: BBS & NET/ROM node](../run/radios/packet-node.md).
