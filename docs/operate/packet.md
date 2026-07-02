# Packet: BBS & NET/ROM node

Beyond APRS, aprscaching is a connected-mode packet station: an AX.25 data-link stack, a NET/ROM node, and
a store-and-forward BBS that forwards mail with the wider packet network. These run on the operator-local
ingest box over a KISS TNC.

## Connected-mode AX.25

The data-link layer (`@aprsweb/ax25`) is a pure, event-driven AX.25 v2.2 (LAPB-derived) state machine — no
I/O and no real timers, so it is exhaustively testable and identical on every runtime. It implements:

- **SABM/UA** connect and accept, **DISC/UA** release, DM, and FRMR recovery;
- **I-frame** transfer with windowing and the V(S)/V(R)/V(A) counters;
- supervisory **RR / RNR / REJ**, and **SREJ** selective-reject with a receive buffer;
- **modulo-128 (SABME)** extended-window connects — 7-bit sequence numbers for high-throughput links;
- **T1** retransmission with **N2** retries, **T3** idle keepalive, and the poll/final timer-recovery cycle.

The modulus is chosen for an outgoing connect and adopted from the peer's SABM/SABME on an incoming one;
SREJ is opt-in per link. Defaults: `t1` 3 s, `t3` 30 s, `n2` 10, window 4, modulo 8. The state machine is
complete and unit-tested; the byte transport to a radio is provided by the host, so on-air bring-up is a
deploy step.

## NET/ROM node

Set `NETROM_CALL` and `NETROM_ALIAS` (both required) to run a node over KISS. It:

- broadcasts its **NODES** table on an interval (`NETROM_BROADCAST_MS`, default 5 min) and learns routes from
  inbound NODES broadcasts, decaying obsolescence;
- switches directed NET/ROM frames — deliver locally, transit-forward, or drop;
- accepts **L4 circuits** terminating at the node (bound to the node command line) and supports
  **connect-through** (`C <dest>`) that routes and bridges a caller onward;
- mirrors its learned NODES table and MHeard list to the gateway (`/api/node/nodes`, `/api/node/mheard`).

## BBS

There are two BBS surfaces:

- **Connected-mode FBB/MBL BBS.** Set `BBS_NODE_CALL` and the node answers inbound AX.25 connects with the
  F6FBB command set (list, read, send, kill, help, …) backed by a per-caller snapshot of the gateway's mail
  store.
- **Connectionless store-and-forward.** The gateway holds personal mail and bulletins; personal mail is
  **held until the addressee is next heard**, then delivered as a standard APRS message with line-number ack
  tracking. The relay callsign is `BBS_CALL` (default `APRSCG`). Message format (P/B type + BID) is
  MBL/FBB-compatible. See the public BBS endpoints in the [API reference](../reference/api.md#bbs-public).

### FBB forwarding

Enable outbound forwarding with `BBS_FORWARD=1` and `BBS_FORWARD_CALL`. The forwarder opens connected-mode
AX.25 sessions to partner BBSes and exchanges mail using the **ASCII FBB** protocol, with hierarchical
`TO@BBS.#REGION.STATE.CC.CONT` addressing, longest-prefix routing, and BID/MID de-duplication. Partners and
routing rules are configured on the sysop surface (see [Administration](administration.md)). Multi-hop
connect scripts are supported.

!!! note "LZHUF compression is not implemented"
    FBB binary B0/B1 (LZHUF) compression is deliberately not built — its correctness *is* byte-exact
    compatibility with FBB's fixed tables, which can only be validated against a real FBB partner. ASCII FBB
    forwarding is fully interoperable without it.

## Internet crosslinks

A NET/ROM node and FBB forwarding can run over the internet leg instead of (or alongside) RF, using the
bidirectional **AXUDP** or **AXIP** ports — set `AXUDP_PEERS` / `AXIP_PEERS` (see
[RF ingest & transports](rf-ingest.md#transports)). This lets your node join the wider BPQ-style packet mesh
without a radio path to every neighbour.
