# Packet: BBS & NET/ROM node

This page turns the ingest box into a connected-mode packet station: a NET/ROM node, a BBS, and FBB mail
forwarding with the wider packet network. It is for the sysop; at the end the node answers connects and
trades routes with its neighbours.

These services run on the operator's own ingest box, over its radio (the KISS TNC, else the first
[soundcard port](soundcard.md)), or over an AXUDP link to other nodes when the box has no radio.

!!! warning "These services transmit automatically"
    Over a radio, the NET/ROM node, the BBS and FBB forwarding answer and send on the air without an
    operator at the key. Read [Automatic stations on the air](../compliance/on-air-stations.md) before you
    turn them on with a radio.

## Before you start

- An ingest box with a working radio: a [KISS TNC](quick-starts.md#kiss-tnc-with-direwolf-soundcard-or-hardware-tnc)
  with PTT or a [soundcard port](soundcard.md) with its PTT; or a two-way
  [AXUDP link](quick-starts.md#axudp-and-axip-packet-over-the-internet) (`AXUDP_PEERS`).
- A callsign-SSID for each service, for example `OE8APR-5` for the node and `OE8APR-8` for the BBS
  ([Callsigns and SSIDs](rf-ingest.md#callsigns-and-ssids)).
- Settings go in the box's settings file (`deploy/.env` in Docker); restart the ingest after each change.

## Connected-mode AX.25

The node and the BBS run on the ingest box's own AX.25 stack, over its radio (the KISS TNC, else the first
soundcard port) or an AXUDP port. Defaults:
`t1` 3 s, `t3` 30 s, `n2` 10, window 4, modulo 8. The modulus is chosen for an outgoing connect and adopted
from the peer on an incoming one, and SREJ is opt-in per link. How the stack works is in
[The AX.25 stack](../../contribute/ax25-stack.md).

Players' tools run in their browsers, never on the ingest box, so they take no part in the node's or the BBS's
sessions: those answer with their own commands only. Tools answer on a player's own packet terminal
([Tools on connected sessions](../../shack/tools.md#tools-on-connected-sessions)).

## NET/ROM node

Set `NETROM_CALL` and `NETROM_ALIAS` (both required) to run a node over the box's radio or, without one, over
a two-way AXUDP port. The node:

- broadcasts its **NODES** table every `NETROM_BROADCAST_MS` (default 3600000, one hour; at least five minutes) and learns
  routes from the NODES broadcasts it hears, letting stale routes age out; `NETROM_PATH_QUALITY` (0–255) is
  the quality it assumes for a neighbour heard directly;
- switches directed NET/ROM frames: delivers them locally, forwards them on, or drops them;
- accepts **L4 circuits** that end at the node (bound to the node command line), and **connect-through**
  (`C <dest>`), which routes a caller onward and bridges the two;
- answers with the command surface set by `NODE_PERSONALITY`: `netrom`, `flexnet`, `tnn` or `baycom`;
- mirrors its learned NODES table and its MHeard list to the gateway (`/api/node/nodes`, `/api/node/mheard`).

**Check that it worked.** The box logs `[netrom] node <ALIAS>:<CALL> active on <port>` and, once it answers
connects, `[netrom] node CLI answering inbound connects on <CALL>`. Learned routes log as
`[netrom] learned … route(s)` and appear in the **NET/ROM node** app in the Shack and under
**Instance admin**.

### INP3 routing

Set `NETROM_INP3=1` to also speak **INP3** (Improved NET/ROM) beside the NODES broadcasts. INP3 replaces the 0–255 quality and
the fixed five-minute flood with **triggered, point-to-point Routing Information Frames (RIFs)**, ranked by
the measured **round-trip transport time (`tt`)**. The network converges faster and prefers paths with low
latency. The node:

- learns routes from a neighbour's directed RIF, adds the link's own `tt` to each route, and advertises
  again only what changed, within a 30-hop horizon;
- measures each neighbour's latency with **L3RTT** probes and takes a route's `tt` as half the smoothed
  round trip;
- withdraws a route (`tt = 60000`) when its neighbour does, or when it ages out;
- shows INP3 routes in the same node table, with their `tt` mapped to a NET/ROM-style quality for display
  only; routing stays on `tt`.

The log shows `[inp3] enabled — RIF learning, L3RTT probing, triggered updates on <port>`. Classic NODES
broadcasting keeps running, so an INP3 node still works with plain NET/ROM neighbours.

## BBS

Set `BBS_NODE_CALL`, and the box answers inbound AX.25 connects to that call with the F6FBB command set
(list, read, send, kill, help, …), backed by a per-caller snapshot of the gateway's mail store. The log shows
`[bbs] BBS answering inbound connects on <CALL> (FBB forwarding gate armed)`.

The gateway holds the BBS's message base: personal mail, bulletins and NTS traffic. It moves them the F6FBB way
only: stations read and write over a connect to the packet BBS, and FBB forwarding exchanges them with partner
BBSes. The BBS never sends over APRS or MeshCom. The message format (P/B/T type and BID) is MBL/FBB-compatible. A message posted here gets the BID `<number>_<call>`, the number in base 36 and the call the sysop's base call, within the 12 characters F6FBB accepts. FBB forwarding therefore needs the gateway's `ADMIN_CALLSIGNS` (or `SERVICE_CALL`) to name the BBS's call; the box warns at start when they differ. The public BBS endpoints are in the [API reference](../../reference/api.md#bbs).

### FBB forwarding

Set `BBS_FORWARD=1` and `BBS_FORWARD_CALL` to forward mail. It needs the box's radio (the KISS TNC or a
soundcard port) or a two-way AXUDP port.
The forwarder opens connected-mode AX.25 sessions to partner BBSes and exchanges mail with the **ASCII FBB**
protocol. It uses hierarchical `TO@BBS.#REGION.STATE.CC.CONT` addressing, longest-prefix routing, and BID/MID
de-duplication, and runs multi-hop connect scripts. It checks its queue every `BBS_FORWARD_POLL_MS` (default
60000) and presents `BBS_FORWARD_SID` to partners. The log shows
`[forward] FBB forwarding scheduler active as <CALL>`.

The forwarder offers partners the mail of senders whose base call is control-verified on this instance. Mail from
an unverified sender stays on this BBS for its addressee. Federation records go only to a partner marked for
federation, and only with `FED_BBS` on: [Federation over FBB](../federation/fbb.md), experimental and off by
default.

Partners and routing rules are set under **Instance admin → FBB forwarding**
([Instance admin at a glance](../day-to-day/index.md)).

**Compressed forwarding.** Set `BBS_FORWARD_COMPRESS=1` to offer FBB binary compressed forwarding (LZHUF,
B1). The binary blocks (SOH/STX/EOT, `FA` proposals, `FS !offset` resume) travel in the same forwarding
session, and FBB MD5 link authentication is supported. Compression starts only when the partner's SID also
advertises the `B` flag. Against an ASCII-only partner the session falls back to plain ASCII, so the option
is always safe to turn on.

## Federation sync

The box can carry federation records over the same stack. With `FED_LINK_SERVE=1` it answers pull requests on
`FED_LINK_CALL`, and the node answers the `FED` command; the pages come from your own gateway. With
`FED_LINK_PULL=1` it dials the peers that publish an `ax25` or `netrom` endpoint, one session per
`FED_LINK_PULL_MS` (default one hour), and hands every page to your gateway, which checks each record's
signature. The log shows `[fedlink] federation sync answering inbound connects on <CALL>` and
`[fedlink] packet pull active as <CALL>`. Both sides, the timings and the limits are in
[Packet circuit](../federation/transports.md#packet-circuit).

## Internet crosslinks

A NET/ROM node and FBB forwarding can run over the internet instead of RF, or beside it, on the two-way
**AXUDP** or **AXIP** ports: set `AXUDP_PEERS` or `AXIP_PEERS` ([Transports](rf-ingest.md#transports)). Your
node then joins the wider BPQ-style packet mesh without a radio path to every neighbour. Between two 44Net
addresses, see [AXUDP and AXIP peering over 44Net](../networks/44net.md#axudp-and-axip-peering-over-44net).
Frames that arrive this way stay Tier C.

## Next

- [Remote control of your box](remote-box.md): drive the box from the web app.
- [Automatic stations on the air](../compliance/on-air-stations.md): the rules for a station that answers
  on its own.
