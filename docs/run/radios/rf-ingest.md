# RF ingest & transports

This page lists what the ingest box does with each radio link, and which frames can count toward Tier A. It
is for the sysop who configures the box; step-by-step setups are in
[Connect a radio: quick starts](quick-starts.md).

The **ingest box** (`apps/ingest`) is how real radio enters an instance. It runs on the operator's own
machine, next to the radio or TNC, never inside a cloud gateway. Only the box that touched the radio can
vouch for what it heard, which is why ingest is always local. Setting up a box for a gateway on another
machine is in [Set up an ingest box](ingest-box.md).

## How the box works

Every transport decodes into a normalised packet and adds it to one batch. Every `BATCH_MS` (default
1500 ms; the `.env` that `deploy/setup.sh` writes from `deploy/.env.example` sets 2000 ms) the box posts the batch as JSON to `INGEST_URL` (default
`http://127.0.0.1:8787/ingest`). It signs the request with its own key when it is enrolled (`BOX_ID`,
`BOX_KEY`), and otherwise sends the shared `INGEST_SECRET` in the `x-ingest-secret` header. `INGEST_URL` can
point at a gateway on `localhost`, on your LAN or in the cloud: the box works with a gateway anywhere.
While the gateway is unreachable, the box keeps up to `INGEST_SPOOL_MAX` (5000) packets and drops the oldest.

The APRS-IS feed always runs: set `APRSIS_FILTER`, and `APRSIS_CALLSIGN` / `APRSIS_PASSCODE` for a
logged-in feed. Every transport below is opt-in and starts only when its setting is present. Each stamps its
own `port`, counted at `GET /api/ports`.

## Transports

| Transport | Turn on with | What it does |
|-----------|-------------|--------------|
| **KISS-over-TCP** | `KISS_TNC_HOST` (+ `KISS_TNC_PORT`, 8001) | Connects to a KISS TNC (for example Direwolf). Decodes AX.25, emits RF-heard packets, and offers transmit to the digipeater, IGate and node. The digipeater and IGate need it; the NET/ROM node, BBS and FBB forwarder run over it, or over an AXUDP link when there is no TNC. A MeshCom node's KISS port is refused: the box logs an error and ignores it, because a frame the MeshCom server relayed would read as heard directly. Listen to a node with `MESHCOM_NODE`. |
| **Soundcard port** | `SOUNDCARD_DEVICE` (+ `SOUNDCARD_*`, `SOUNDCARD_PORTS`) | The box is the 1200-baud AFSK modem: ALSA's `arecord` and `aplay` with a USB sound card or a sound HAT, keyed by a PTT driver (CM108 GPIO, Linux GPIO, serial RTS/DTR, CAT, rigctld or VOX). Receives like a KISS TNC and carries the same functions. Transmit is off by default and needs a control-verified call; a watchdog bounds the key time. Setup: [Soundcard port](soundcard.md). |
| **AGWPE** | `AGWPE_HOST` (+ `AGWPE_PORT`, 8000; `AGWPE_RADIO_PORT`, 0) | Connects to an AGW Packet Engine (Direwolf, SoundModem, UZ7HO) and reads its raw monitor. Receive only. |
| **WA8DED hostmode** | `HOSTMODE_HOST` (+ `HOSTMODE_PORT`, 3694; `HOSTMODE_MYCALL`) | A TF-firmware TNC or TFPCX over TCP; monitor headers (`fm SRC to DST via DIGI* ctl … pid …`, or TNC2 form) become APRS lines. Receive only. |
| **Meshtastic** | `MESHTASTIC_HOST` (+ `MESHTASTIC_PORT`, 4403) and/or `MESHTASTIC_MQTT_URL` (+ `MESHTASTIC_MQTT_TOPIC`, `msh/#`) | Reads the protobuf stream of a node's TCP API, or the protobuf ServiceEnvelopes nodes send to an MQTT broker ([quick start](quick-starts.md#meshtastic)). Accepts only licensed nodes (licensed ham mode on, callsign as long name), under their callsign; drops licence-free nodes. Always Tier C. The browser's Web Serial path uses the same decoder and rule. |
| **MeshCom** | `MESHCOM_NODE` (+ `MESHCOM_BIND`, `MESHCOM_FANOUT`) | Listens for the ExtUDP JSON of one or more MeshCom nodes on the LAN (on the node: `--extudpip <ingest box IP>` and `--extudp on`). Positions reach the map, direct messages the message log, group and broadcast text only the port monitor. Accepts only configured node addresses, rate-capped per node; a frame the node reports twice (LoRa and server) is forwarded once. Transmits only answers to radio commands, and only with `MESHCOM_TX=1`. Setup, firewall, trust and troubleshooting: [MeshCom](meshcom.md). |
| **AXUDP** | `AXUDP_PORT` (+ `AXUDP_PEERS`, `AXUDP_BIND`) | AX.25 over UDP (BPQ mesh, port 10093). Without peers it is a receive-only listener that accepts from any host and says so at start; bind it to a LAN address with `AXUDP_BIND`. With `AXUDP_PEERS` it is a two-way port that carries NET/ROM crosslinks and FBB forwarding over the internet, and accepts frames only from the peers' addresses. Host names are resolved again every five minutes, so dynamic DNS works; anything else is dropped and counted. |
| **AXIP** | `AXIP_ENABLE` or `AXIP_PEERS` (+ `AXIP_BIND`) | AX.25 in raw IP protocol 93 (JNOS/BPQ AXIP). Needs the optional `raw-socket` package and `CAP_NET_RAW`; without them it logs and stays off. Receive only with `AXIP_ENABLE`; two-way with `AXIP_PEERS`, accepting frames only from the peers' addresses, like AXUDP. |

!!! warning "Tunnelled frames are always Tier C"
    A frame that arrives over AXUDP or AXIP came through an internet tunnel, and Meshtastic is a
    licence-free carrier: no receiver you run heard either on amateur RF. The gateway never counts such a
    frame as first-party evidence, even when it names an attested site, so it can never reach Tier A
    ([transport is not trust](../../reference/trust-model.md#transport-is-not-trust)). Naming tunnel peers
    in `AXUDP_PEERS` or `AXIP_PEERS` lets the node send over the tunnel; transmitting on the air is a
    separate matter ([On-air legality](#on-air-legality)).

## Callsigns and SSIDs

Every station of yours is your callsign with its own SSID. Give each role its SSID once, and keep it:

| Role | Setting | SSID |
|---|---|---|
| The instance's service call: radio commands go to it, answers come from it | `SERVICE_CALL` on the gateway, set for you | `-15` |
| This box's station: IGate, receiving site, remote box, host-mode TNC | `IGATE_CALL`, `RF_SITE_CALL`, `BOX_CALL`, `HOSTMODE_MYCALL` | `-10` |
| The digipeater | `DIGI_CALL` | the station's, `-10` |
| The NET/ROM node | `NETROM_CALL` | `-5` |
| The packet BBS, for connects and FBB forwarding | `BBS_NODE_CALL` (`BBS_FORWARD_CALL` follows it) | `-8` |
| A MeshCom node | its own call in `MESHCOM_NODE` | the node's |

Each setting switches its role on, so the box never sets one for you. A callsign setting takes a base of up
to six letters and digits with a digit in it, and an SSID from 0 to 15; anything else stops the start with
the setting's name. Once the gateway answers, the box logs an error for a station on the service call, and
for a receiving site or MeshCom node the gateway does not trust (**Instance admin → Trusted receiving
stations**, or `FIRST_PARTY_SITES`).

## Receiving site and Tier A

Set `RF_SITE_CALL` (default: `IGATE_CALL`) to name the box as a receiving site. Every frame one of its local
TNCs (KISS, AGWPE or WA8DED host mode) or soundcard ports hears **directly** carries that callsign to the
gateway. A gateway that
trusts the call counts those frames as RF-corroborated evidence for Tier A, with no APRS-IS round trip, so it
works off-grid too. The gateway's independence rule still keeps your own receiver from corroborating your own
finds.

The sysop trusts a receiving station in one of three ways:

| Where | For | Changed by |
|---|---|---|
| **Instance admin → Trusted receiving stations**: **Trust station** with its site call | A receiver you operate, such as your own box on the shared `INGEST_SECRET` | The sysop, in the app: add and remove |
| **Instance admin → Ingest boxes**: **Trust this station's hearings** on an enrolled box | A receiver a ham lends to your instance ([Lend your receiver to an instance](lend-a-receiver.md)) | The sysop, in the app: switch on and off; revoking the box ends it |
| `FIRST_PARTY_SITES` on the gateway | Presetting trusted stations from configuration: CI, scripted deploys, an off-grid Desktop or Pocket | The configuration; listed read-only in the app as **set in configuration** |

Instance admin is the primary way. Every trusted station shows there with since when and by whom it is trusted,
and the finds it verified. Nothing is trusted until you add it: Tier A stays closed until then.

A frame counts as heard directly only when no path hop shows a relay:

- no hop carries the has-been-repeated `*`;
- the first hop is not a decremented `WIDEn-N` or `TRACEn-N` (N below n, as in `WIDE2-1` from `WIDE2-2`),
  which is how an untraced digipeater uses up a hop without marking it.

Digipeaters use hops in order, so the hops after an untouched first hop are as the originator set them:
`WIDE1-1,WIDE2-1` (the standard mobile path) and `WIDE1-1,WIDE2-2` count as direct. The rule is
conservative: a station whose first hop is `WIDE2-1` looks the same as a decremented `WIDE2-2`, so its frames
name no site. Digipeated frames name no site: they show the originator was near the digipeater, not near
your receiver.

Only this path attests. A frame that reaches the gateway over APRS-IS, even one tagged `qAR,<your site>`,
stays Tier C: APRS-IS passcodes are public, and anyone can send such a line. An IGate that your gateway sees
only on APRS-IS therefore adds nothing to Tier A. For its hearings to count, run an ingest box on that
IGate's receiver (its TNC as a KISS, AGWPE or host-mode port, with `RF_SITE_CALL` set), so its frames arrive
through the box's own credential.

A MeshCom node is a receiving site in the same way: only a frame it heard directly over LoRa names it, and
only when its call is trusted ([How MeshCom traffic is trusted](meshcom.md#how-meshcom-traffic-is-trusted)).

!!! warning "Only a TNC you operate"
    `RF_SITE_CALL` vouches that **your** receiver heard the frame. If `KISS_TNC_HOST` (or `AGWPE_HOST`,
    `HOSTMODE_HOST`) points at a station you don't operate, such as a club digipeater or a remote HAMNET
    node, leave `RF_SITE_CALL` unset. The frames still arrive, but naming someone else's receiver as your
    site would attest hearings you cannot vouch for.

## IGate

An IGate passes traffic between RF and APRS-IS. It needs a KISS TNC or a soundcard port, and both
`IGATE_CALL` and `IGATE_PASS`.
With those two set it receives only: the RX direction needs no transmitter. Passing APRS-IS messages down to
RF transmits, so it also needs `IGATE_TX=1`.

- **RX-IGate** passes each RF frame up to APRS-IS with a `qAR,<yourcall>` construct. That copy is for the
  APRS-IS network: no instance attests it, because anyone with a public passcode can send the same line.
  Your hearings count toward Tier A through the box's own batch to the gateway, as in
  [Receiving site and Tier A](#receiving-site-and-tier-a).
- **TX-IGate**, with `IGATE_TX=1`, passes APRS-IS messages, acks and rejects included, down to RF, but only
  to stations heard locally within `IGATE_LOCAL_TTL` seconds (default 1800, 30 minutes) and only when the
  sender is not heard locally itself. It honours the APRS-IS to RF do-not-gate tokens (`TCPXX`, `NOGATE`, `RFONLY`; the `TCPIP*`
  every APRS-IS client message carries does not block it) and skips third-party frames and its own traffic.
  Each message goes out under `IGATE_CALL` in third-party format, `}SENDER>DEST,TCPIP,IGATE_CALL*:<message>`,
  so the station identifies as itself on air. `IGATE_TX_PATH` sets its RF path (default none, since the
  addressee was heard locally; for example `WIDE1-1`). `IGATE_FILTER` is the APRS-IS filter for the traffic
  it may pass to RF.

## Digipeater

Set `DIGI_CALL`, and optionally `DIGI_ALIASES` (default `WIDE1,WIDE2`), to repeat traffic with the new n-N
paradigm, over a KISS TNC or a soundcard port. With several radio ports, each frame is repeated on the port
that heard it. It inserts your call with the has-been-repeated bit and decrements `WIDEn-N`, with a
loop guard and a 30-second window that keeps it from repeating the same frame twice.

Set `DIGI_CONNECTED=1` to also repeat connected-mode frames (SABM, I, RR, …) whose next unrepeated hop is
your call; this relays NET/ROM crosslinks and FBB traffic through you. `DIGI_VISCOUS_MS` makes this
connected-mode digipeater **viscous**: it holds a repeat that long and cancels it when a better-placed
digipeater is heard repeating the same frame.

## From a container

A KISS TNC over TCP (`KISS_TNC_HOST`), AGWPE (Direwolf, SoundModem) and hostmode all reach the ingest
container over the network: run the TNC software on the host or another box, and point the settings at it.
Inside the container the host is not `localhost`: use the host's LAN address. AXUDP needs no special
privileges. AXIP (raw IP protocol 93) needs `CAP_NET_RAW`: add `cap_add: [NET_RAW]` to the ingest service.

**MeshCom** nodes send UDP to port 1799 on the box, so the ingest container has to receive it. In
`deploy/docker-compose.yml` (or `deploy/compose.ingest-only.yml`), uncomment the `ports:` line on the ingest
service and put your host's LAN address in it. Then set `MESHCOM_BIND=0.0.0.0` in `deploy/.env`: inside the
container that is only the container's own interface, and the published port exposes it on your LAN address
alone. To receive AXUDP in a container, publish its UDP port the same way, on one address only. See
[MeshCom](meshcom.md).

## Transmit gate

Every port the box transmits on, the KISS TNC, the [soundcard ports](soundcard.md) and MeshCom transmit
(`MESHCOM_TX`), sends only while the box's transmit switch is on and the gateway confirms the station call it
sends under: control-verified, not suspended, and held by whoever runs the box
([The transmit gate](soundcard.md#the-transmit-gate)). The gate judges each frame by the box's calls it carries,
as source or as a via hop, so a call the gateway refuses holds back only its own frames: an `IGATE_CALL` you keep
receive-only does not silence the digipeater. Receiving goes on regardless. The log says why:
`[kiss] transmit refused: verify OE8APR-10 to transmit — control-verification required`.

The box asks the gateway every three minutes. An answer that a call is not verified, is suspended, or is not
this box's operator's, closes the gate for that call at once. While the gateway cannot be reached (no network, a timeout, a server
error, a gateway without the endpoint), the last confirmation keeps counting for `TX_GATE_GRACE`: 6 minutes by
default, up to 24 hours (`30`, `30m` or `2h`; a plain number is minutes). Past it the box stops transmitting
until the gateway answers again, and it asks every 30 seconds or so meanwhile. Raise the grace for a link that
drops out, such as a HAMNET or mobile-data link; keep it short where you can, since a call revoked during an
outage keeps transmitting for up to the grace. The doctor shows it (`ingest.tx_gate_grace`) and warns above an
hour.

## On-air legality

Every transmit path above (digipeater, IGate, node, BBS forwarding, answers to radio commands) makes your
station an automatically controlled one. Read [Automatic stations on the air](../compliance/on-air-stations.md)
before you turn on transmit.

## Next

- [MeshCom](meshcom.md): a MeshCom node as a receiving site.
- [Packet: BBS & NET/ROM node](packet-node.md): the node and BBS on top of these transports.
