# RF ingest & transports

The **ingest box** is how real radio enters an instance. It is a Node process (`apps/ingest`) that runs on
the operator's own machine, next to the radio or TNC — never in the cloud gateway. Only the box that
physically touched RF can attest first-party reception, which is why ingest is always local.

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
| **KISS-over-TCP** | `KISS_TNC_HOST` (+ `KISS_TNC_PORT`, 8001) | Connects to a KISS TNC (e.g. Direwolf). Decodes AX.25, emits RF-heard packets, and exposes TX for the digipeater / IGate / node. This transport gates the digipeater, NET/ROM node, BBS, IGate, and forwarder blocks. |
| **AGWPE** | `AGWPE_HOST` (+ port, radio-port) | Connects to an AGW Packet Engine (Direwolf, SoundModem, UZ7HO); raw monitor in, keying out. |
| **WA8DED hostmode** | `HOSTMODE_HOST` (+ `HOSTMODE_MYCALL`) | A TF-firmware TNC or TFPCX over TCP; monitor headers become APRS lines. |
| **Meshtastic** | `MESH_HOST` (+ `MESH_PORT`, 1883) | Reads newline-delimited JSON over TCP (an MQTT→TCP bridge / `mosquitto_sub -F %j`) and maps mesh positions to APRS. The native Meshtastic protobuf decoder (`ServiceEnvelope` / `FromRadio` → position / text / node-info) ships in the library and drives the browser-direct serial/BLE path. |
| **TAK / CoT in** | `TAK_COT_PORT` | A UDP listener that parses inbound Cursor-on-Target events into APRS positions. |
| **AXUDP** | `AXUDP_PORT` (+ `AXUDP_PEERS`) | AX.25 over UDP (BPQ mesh, port 10093). Without peers it's an RX-only listener; with `AXUDP_PEERS` it's a bidirectional port carrying NET/ROM crosslinks and FBB forwarding over the internet leg. |
| **AXIP** | `AXIP_ENABLE` or `AXIP_PEERS` | AX.25 in raw IP protocol 93 (JNOS/BPQ AXIP). Needs the optional `raw-socket` package and `CAP_NET_RAW`; absent, it logs and stays inert. RX-only with `AXIP_ENABLE`; bidirectional (RX + TX) with `AXIP_PEERS`. |

!!! warning "Tunnelled frames are always Tier C"
    AXUDP and AXIP frames are forwarded as `heardVia: aprs_is` on their own port, so the gateway's provenance
    derivation stamps `firstPartyAttested = false`. A tunnelled frame can **never** reach Tier A — transport
    is not trust. AXUDP/AXIP transmit is operator-config-gated node transport (you set `*_PEERS`), which is
    distinct from on-air keying (that is the separate, verified-callsign gate).

## IGate

An IGate bridges RF and APRS-IS in both directions. It needs a KISS TNC and both `IGATE_CALL` and
`IGATE_PASS`:

- **RX-IGate** relays each RF frame up to APRS-IS with a `qAR,<yourcall>` construct — this is what makes a
  find you personally gated eligible for **Tier A** corroboration by others.
- **TX-IGate** gates APRS-IS messages down to RF, but only to stations heard locally within `IGATE_LOCAL_TTL`
  (default 30 min), honouring the standard do-not-gate tokens (`TCPIP`, `TCPXX`, `NOGATE`, `RFONLY`),
  skipping third-party frames, own beacons, and bare acks.

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
