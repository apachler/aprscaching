# RF ingest & transports

The **ingest box** is how real radio enters an instance. It is a Node process (`apps/ingest`) that runs on
the operator's own machine, next to the radio or TNC — never in the cloud gateway. Only the box that
physically touched RF can attest first-party reception, which is why ingest is always local.

!!! tip "Step by step"
    [Connect a radio: quick starts](quickstarts.md) walks through each link below — APRS-IS, a KISS TNC with
    Direwolf, your own IGate, Meshtastic, MeshCom, AXUDP — with the log line that shows it works.

## How the box works

Every transport decodes into a normalized packet and pushes it into one batch. Every `BATCH_MS` (default
1500 ms) the box POSTs the batch as JSON to `INGEST_URL` (default `http://127.0.0.1:8787/ingest`) with the
`x-ingest-secret` header. Set `INGEST_SECRET` to match your gateway; point `INGEST_URL` at a gateway on
`localhost`, your LAN, or a remote cloud — the box is gateway-location-agnostic.

The APRS-IS feed is always available: set `APRSIS_FILTER` (and optionally `APRSIS_CALLSIGN` /
`APRSIS_PASSCODE` for a logged-in feed). Every transport below is opt-in and starts only when its variable is
present. Each stamps its own `port`, visible at `GET /api/ports`.

## Transports

| Transport | Enable with | What it does |
|-----------|-------------|--------------|
| **KISS-over-TCP** | `KISS_TNC_HOST` (+ `KISS_TNC_PORT`, 8001) | Connects to a KISS TNC (e.g. Direwolf). Decodes AX.25, emits RF-heard packets, and exposes TX for the digipeater / IGate / node. The digipeater and IGate need it; the NET/ROM node, BBS and FBB forwarder run over it, or over an AXUDP link when there is no TNC. |
| **AGWPE** | `AGWPE_HOST` (+ port, radio-port) | Connects to an AGW Packet Engine (Direwolf, SoundModem, UZ7HO); raw monitor in, keying out. |
| **WA8DED hostmode** | `HOSTMODE_HOST` (+ `HOSTMODE_MYCALL`) | A TF-firmware TNC or TFPCX over TCP; monitor headers (`fm SRC to DST via DIGI* ctl … pid …`, or TNC2 form) become APRS lines. |
| **Meshtastic** | `MESHTASTIC_HOST` (+ `MESHTASTIC_PORT`, 4403) and/or `MESHTASTIC_MQTT_URL` (+ `MESHTASTIC_MQTT_TOPIC`, `msh/#`) | Reads the protobuf stream of a node's TCP API, or the protobuf ServiceEnvelopes nodes uplink to an MQTT broker ([quick start](quickstarts.md#meshtastic)). Only licensed nodes — licensed (ham) mode on, callsign as long name — are accepted, under their callsign; licence-free nodes are dropped. Always tier C. The browser-direct Web Serial path uses the same decoder and rule. |
| **MeshCom** | `MESHCOM_NODE` (+ `MESHCOM_BIND`, `MESHCOM_FANOUT`) | Listens for the ExtUDP JSON of one or more MeshCom nodes on the LAN (on the node: `--extudpip <ingest box IP>` and `--extudp on`). Positions reach the map, direct messages the message log, group and broadcast text only the port monitor. Only configured node addresses are accepted, per-node rate-capped; a frame the node reports twice (LoRa and server) is forwarded once. Transmits only answers to radio commands, and only with `MESHCOM_TX=1`. Setup, firewall and troubleshooting: [MeshCom](meshcom.md). |
| **AXUDP** | `AXUDP_PORT` (+ `AXUDP_PEERS`) | AX.25 over UDP (BPQ mesh, port 10093). Without peers it's an RX-only listener; with `AXUDP_PEERS` it's a bidirectional port carrying NET/ROM crosslinks and FBB forwarding over the internet leg, and accepts frames only from the peers' addresses (host names are re-resolved every five minutes, so dynamic DNS works); anything else is dropped and counted. The RX-only listener accepts from any host and says so at startup — bind it to a LAN address with `AXUDP_BIND`. |
| **AXIP** | `AXIP_ENABLE` or `AXIP_PEERS` | AX.25 in raw IP protocol 93 (JNOS/BPQ AXIP). Needs the optional `raw-socket` package and `CAP_NET_RAW`; absent, it logs and stays inert. RX-only with `AXIP_ENABLE`; bidirectional (RX + TX) with `AXIP_PEERS`, accepting frames only from the peers' addresses, like AXUDP. |

!!! warning "MeshCom reaches Tier A only as a direct hearing at an attested node"
    A MeshCom node also reports frames it got from the MeshCom server over the internet (`src_type: udp`),
    frames relayed through other nodes, and its own traffic. Only a frame the node heard **directly** over
    LoRa is forwarded as RF with the node as its receiving site, and it counts toward Tier A only when that
    node's call (`MESHCOM_NODE=<ip>=<CALL>`) is in the gateway's `FIRST_PARTY_SITES`. Everything else is
    Tier C. See [MeshCom](meshcom.md#how-meshcom-traffic-is-trusted).

!!! warning "Tunnelled frames are always Tier C"
    AXUDP and AXIP frames are forwarded as `heardVia: aprs_is` on their own port, so the gateway's provenance
    derivation stamps `firstPartyAttested = false` — and it refuses attestation to any position recorded
    on the AXUDP, AXIP or Meshtastic transport, even one that names an attested site. A tunnelled frame can
    **never** reach Tier A — transport is not trust. AXUDP/AXIP transmit is operator-config-gated node transport (you set `*_PEERS`), which is
    distinct from on-air keying (that is the separate, verified-callsign gate).

## Receiving site and Tier A

Set `RF_SITE_CALL` (default: `IGATE_CALL`) to name the box as a receiving site. Every frame one of its
local TNCs — KISS, AGWPE or WA8DED host mode — hears **directly** carries that callsign to the gateway.
A frame counts as heard directly only when no path hop shows a relay: no hop carries the has-been-repeated
`*`, and the first hop is not a decremented `WIDEn-N` / `TRACEn-N` (N below n — `WIDE2-1`, `WIDE2`), which is
how an untraced digipeater consumes a hop without marking it. Digipeaters consume hops in order, so the hops
after an untouched first hop are exactly as the originator set them: `WIDE1-1,WIDE2-1` (the standard mobile
path) and `WIDE1-1,WIDE2-2` count as direct. The rule is conservative: a station whose first hop is `WIDE2-1`
looks the same as a decremented `WIDE2-2`, so its frames name no site. A gateway that lists
the call in `FIRST_PARTY_SITES` then counts those frames as RF-corroborated evidence for Tier A, with no
APRS-IS round trip, so it works off-grid too. Digipeated frames name no site: they show the originator was
near the digipeater, not near your receiver. The gateway's independence rule still keeps your own
receiver from corroborating your own finds.

Only this path attests. A frame that reaches the gateway over APRS-IS — even one tagged `qAR,<your site>` —
stays Tier C, because APRS-IS passcodes are public and anyone can inject such a line. An IGate that is visible
to your gateway only on APRS-IS therefore adds nothing to Tier A: for its hearings to count, run this ingest
box on that IGate's receiver (its TNC as a KISS, AGWPE or host-mode port, with `RF_SITE_CALL` set), so its
frames arrive through the ingest secret.

!!! warning "Only a TNC you operate"
    `RF_SITE_CALL` vouches that **your** receiver heard the frame. If `KISS_TNC_HOST` (or `AGWPE_HOST`,
    `HOSTMODE_HOST`) points at a station you don't operate — a club digipeater, a remote HAMNET node —
    leave `RF_SITE_CALL` unset: the frames still arrive, but naming someone else's receiver as your site
    would attest hearings you cannot vouch for.

## IGate

An IGate bridges RF and APRS-IS in both directions. It needs a KISS TNC and both `IGATE_CALL` and
`IGATE_PASS`:

- **RX-IGate** relays each RF frame up to APRS-IS with a `qAR,<yourcall>` construct. That copy is for the
  APRS-IS network: no instance attests it, because anyone with a (public) passcode can send the same line.
  Your hearings count toward Tier A through the box's own batch to the gateway, as described above.
- **TX-IGate** gates APRS-IS messages, acks and rejects included, down to RF, but only to stations heard
  locally within `IGATE_LOCAL_TTL` (default 30 min) and only when the sender is not heard locally itself.
  It honours the IS → RF do-not-gate tokens (`TCPXX`, `NOGATE`, `RFONLY`; the `TCPIP*` every APRS-IS client
  message carries does not block it) and skips third-party frames and its own traffic. Each message goes out
  under `IGATE_CALL` in third-party format, `}SENDER>DEST,TCPIP,IGATE_CALL*:<message>`, so the station
  identifies as itself on air. `IGATE_TX_PATH` sets its RF path (default none, since the addressee was heard
  locally; e.g. `WIDE1-1`).

## Digipeater

Set `DIGI_CALL` (and optionally `DIGI_ALIASES`, default `WIDE1,WIDE2`) to repeat traffic over a KISS TNC
using the new n-N paradigm — insert your call with the has-been-repeated bit, decrement `WIDEn-N`, with a
loop guard and a dedupe window.

Set `DIGI_CONNECTED=1` to also repeat connected-mode frames (SABM / I / RR …) whose next un-repeated hop is
your call — this relays NET/ROM crosslinks and FBB traffic through you. `DIGI_VISCOUS_MS` enables **viscous**
digipeating: hold a repeat briefly and cancel it if a better-placed digi is heard repeating the same frame.

## Off-grid

Point `INGEST_URL` at a gateway on the same machine (`http://localhost:8787/ingest`) and run a Node gateway
beside the box: RF in, map out, no internet. A cloud VM may also run an APRS-IS-only ingest for a baseline
global feed, but that is never the only path for RF.

## AXUDP and AXIP peering over 44Net

Two packet nodes that each have a 44Net Connect address can link directly, even when both sit behind
CGNAT: a Connect address is reachable from the internet with no port forwarding (see
[Run an instance on 44Net](44net.md#6-who-can-reach-you)). Name the other node by its 44.x address or its
`ampr.org` name:

```bash
AXUDP_PORT=10093
AXUDP_BIND=44.x.y.z                       # listen on the tunnel address only (ingest on the host)
AXUDP_PEERS=oe8xyz.ampr.org:10093         # or 44.a.b.c:10093; several peers comma-separated
# AXIP instead (raw IP protocol 93, needs raw-socket + CAP_NET_RAW):
# AXIP_PEERS=oe8xyz.ampr.org
```

- **Peer enforcement.** With `AXUDP_PEERS` (or `AXIP_PEERS`) set, the port accepts frames only from the
  peers' IPv4 addresses and drops and counts everything else. Names are re-resolved every five minutes, so
  a peer that moves to a new address is followed once its A record changes — within about an hour of the
  change in the ARDC Portal, plus the old record's TTL.
- **Binding.** `AXUDP_BIND` to the 44.x address needs the tunnel up before the ingest starts; a bind to an
  absent address fails and is not retried. In the Docker stack the container does not hold the 44.x
  address: leave `AXUDP_BIND` unset and publish the ingest's UDP port on the tunnel address only
  (`ports: ["44.x.y.z:10093:10093/udp"]`), never on all addresses.
- **Firewall.** Allow the AXUDP port (UDP 10093 by default) on the tunnel interface only from your peers'
  addresses.
- **Frames stay Tier C.** A frame that arrived over AXUDP or AXIP is tunnelled, not heard: it is never
  first-party attested and never reaches Tier A, whatever address it came from.
- **Signed, never encrypted.** WireGuard encrypts only each node's leg to ARDC; the AX.25 frames themselves
  stay plain, and whatever your node puts on the air follows the
  [no-encryption rule](rf-regulatory.md#no-encryption-on-the-air-sign-never-conceal).
- **Unverified:** whether IP protocol 93 (AXIP) passes between two Connect addresses. ARDC states that
  Connect does not filter traffic, which suggests it does, but no test is recorded; AXUDP rides plain UDP and
  is the safer choice.

## On-air legality

Every transmit path above (digipeat, IGate, node, gated user TX) makes your station a control-operated —
and, when automatic, unattended — amateur station. Before you enable TX, read
[Amateur-radio compliance](rf-regulatory.md): encryption is prohibited (aprscaching signs but never
conceals), identification and automatic-station rules apply, and you are the responsible control operator.
