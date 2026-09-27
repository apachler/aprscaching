# MeshCom integration (design)

!!! note "Built and planned"
    The receive-only listener is built: `packages/aprs/src/meshcom.ts` decodes the datagrams,
    `apps/ingest/src/meshcom.ts` listens for them, and its configuration is under
    [RF ingest & transports](../operate/rf-ingest.md). Telemetry, find logging over the mesh, transmit and a
    browser-direct path are design only, tracked in
    [`TODO.md`](https://github.com/apachler/aprscaching/blob/dev/TODO.md).

## What MeshCom is

MeshCom is a LoRa text-and-position mesh for licensed radio amateurs, developed by the
[Institute of Citizen Science for Space & Wireless (ICSSW)](https://icssw.org/meshcom/) and widely
deployed in Austria (ÖVSV), Germany (DARC) and Switzerland. Its firmware is
[MIT-licensed](https://github.com/icssw-org/MeshCom-Firmware), which makes it an open specification in
the sense of the project's IP rule and lets the decoder live in the MIT `packages/aprs`.

| Property | Value |
|---|---|
| Frequency | 433.175 MHz (D-A-CH, EU); 439.9125 MHz (UK); 433.925 MHz (Norway) |
| Modulation | LoRa, SF11, 250 kHz bandwidth, CR 4/6 |
| Framing | APRS source / destination / digipeater path and APRS payload (`:` message, `!` position) inside a small binary header: 32-bit message id, hop byte (hop count + flags), hardware id, modulation id, 16-bit checksum ([protocol](https://icssw.org/en/meshcom-2-0-protokoll/)) |
| Addressing | Direct message to a callsign, group message to a 2–5 digit group number (group 9 = emergency), broadcast to `*` |
| Payload types | Text, position, telemetry (temperature, humidity, pressure) |
| Identity | Real amateur callsigns with SSID (SSIDs above 15 occur, e.g. `-99`) |
| Gateways | A node in gateway mode links its local mesh to the MeshCom servers over HAMNET or the internet; dashboards at [meshcom.oevsv.at](https://meshcom.oevsv.at/) |
| LoRa-APRS side channel | With `--track on` a node also beacons its position on 433.775 MHz (LoRa-APRS) to destination `APRS` (`--aprsmc` changes it), where LoRa-APRS IGates put it on APRS-IS ([details](https://icssw.org/en/2026/06/10/meshcom-lora-aprs/)) |
| Hardware | T-Beam, Heltec V3, RAK4631, T-Echo, T-Deck and T-Deck Plus (a standalone node with display and keyboard) |

### The external UDP interface

The [UDP interface for external client software](https://icssw.org/en/udp-schnittstelle-fuer-externe-client-software/)
is the integration point. A node joined to Wi-Fi and configured with `--extudpip <ip>` and
`--extudp on` exchanges JSON datagrams on **UDP port 1799**:

```json
{"src_type":"lora","type":"msg","src":"DH1FR-1","dst":"DH1FR-2","msg":"Hello{034","msg_id":"5DFC7187","rssi":-95,"snr":12}
{"src_type":"lora","type":"pos","src":"9V1LH-1,OE1KBC-12","msg":"","lat":1.3773,"lat_dir":"N","long":103.942,"long_dir":"E","aprs_symbol":"#","aprs_symbol_group":"/","hw_id":4,"msg_id":"AE48D54D","alt":161,"batt":5,"firmware":17,"fw_sub":"p","rssi":-95,"snr":12}
{"src_type":"lora","type":"tele","src":"9V1LH-1,OE1KBC-12","batt":5,"temp1":28.9,"temp2":0,"hum":40.2,"qfe":1004.9,"qnh":1005.4}
```

- A client registers with `{"type":"info","src":"<CALL-SSID>"}` and sends with
  `{"type":"msg","dst":"<call | group | *>","msg":"<text>"}` (UTF-8, at most 150 characters).
- `lat`/`long` are unsigned degrees (truncated to four decimals) with the hemisphere in
  `lat_dir`/`long_dir`. `alt` holds the raw `/A=` digits, which are feet or metres depending on a
  per-node setting, so the listener does not forward it.
- `src_type` names where the node got the datagram: `lora` (heard on air), `node` (the node itself),
  `udp` (relayed from the MeshCom server over the internet).
- The trailing `{034` on a message is the APRS message number, used for acknowledgement.
- The interface carries **no authentication and no encryption.**

## How it fits the platform

MeshCom sits between APRS and Meshtastic. Like APRS it carries real callsigns and APRS payloads, so a
MeshCom position maps onto a station and, later, an account without the synthetic `MSH…` names the
Meshtastic bridge invents. Like Meshtastic it is a LoRa mesh reached through a node on the operator's
LAN, not through a TNC.

```
 LoRa 433.175 ──▶ MeshCom node ──UDP :1799 JSON──▶ apps/ingest (MeshcomListener)
                        ▲                                  │ Packet{port:"meshcom"}
                        └──── msg (gated TX) ◀─────────────┤
                                                           ▼ batched POST /ingest
                                                     gateway → map · MHeard · Messages
```

### Where each piece lands

| MeshCom piece | Home in the repo | State |
|---|---|---|
| JSON → APRS frame | `parseMeshcomUdp()` in `packages/aprs/src/meshcom.ts`: a position becomes an uncompressed `!` position; a direct message an APRS `:ADDRESSEE:text{nnn` message; group and `*` text an APRS user-defined `{MG` packet, which the decoder classifies as `other` so it stays out of the message log | built |
| UDP listener | `MeshcomListener` in `apps/ingest/src/meshcom.ts`: pins the source address to `MESHCOM_NODE`, forwards one copy per frame id within ten minutes (a node reports the same frame from LoRa and from the server), registered in `apps/ingest/src/index.ts` | built |
| Configuration | `MESHCOM_NODE` (enables the listener), `MESHCOM_PORT` (1799), `MESHCOM_BIND` | built |
| Transport enum | `"meshcom"` in `Transport` (`packages/shared/src/packet.ts`). Stored positions carry no port, so `transportOf()` in `workers/gateway/src/provenance.ts` does not distinguish it; trust does not depend on it either way | built |
| Positions | `kind:"position"` with `parsed.lat/lon` → live map, MHeard, `GET /api/ports` | built |
| Messages | a direct message → the messages log (`shack.ts`); the Messages surface shows it | built |
| Telemetry | `tele` → the observational weather path (`sensor_readings`); never touches the A/B/C find tiers. The firmware reports an absent sensor as `0`, so the mapping needs a per-field presence rule | planned |

### Callsigns and paths

`src` is a source path. The origin is its first element; later elements are the relaying nodes and go
into `Packet.path` (the firmware builds it that way: the source call ends at the first comma). The
callsign check accepts SSIDs outside the AX.25 0–15 range, as APRS-IS does for TNC2 text, and requires
both a letter and a digit in the base call, which separates calls from group numbers and from the
firmware's internal non-call sources.

## Trust

MeshCom frames are unsigned, and a `udp`-sourced datagram crossed the internet. The design follows the
standing rule that transport is not trust:

- **Every MeshCom packet is Tier C.** The listener forwards with `heardVia: "aprs_is"` on port
  `meshcom`, the same way AXUDP and the Meshtastic bridge do. That matters: `provenanceOf()` lifts a
  packet toward Tier A when `heardVia` is `rf` and `igateCall` names an attested site, so emitting
  `rf` would open Tier A by accident.
- **Tier A is a separate decision** taken with real on-air data. If it opens, it opens only for
  `src_type: "lora"` heard at an operator-attested site, through the existing `firstPartyAttested`
  flag plus an explicit on-air check — never because the transport is MeshCom.
- **Finds logged over the mesh** (see below) stay Tier C unless corroborated by the usual A or B
  evidence; the message itself proves nothing about presence.

## Security

- The listener binds to the LAN (`MESHCOM_BIND`) and drops datagrams whose source address is not
  `MESHCOM_NODE`. Any host on the segment can otherwise inject JSON.
- Port 1799 is never exposed to the internet. Pointing `--extudpip` at a cloud gateway would couple RF
  ingest to a cloud host and send unauthenticated traffic across the internet; the operator docs say so
  explicitly.
- Datagrams over 1 KiB are refused before parsing; every field is type- and range-checked, text is
  collapsed to one line and length-bounded, and a malformed datagram is dropped, never thrown.
- The listener never transmits and never registers with the node, so it cannot change the node's
  state.

## Locality

The node talks to the ingest box over the operator's own LAN, which is exactly the shape
[the ingest-locality rule](https://github.com/apachler/aprscaching/blob/dev/.claude/rules/ingest-locality.md)
asks for: a Pi next to the node works off-grid with a local gateway, and the same box can forward to a
LAN or cloud gateway through `INGEST_URL`.

The browser cannot open UDP sockets. A browser-direct path goes over Web Serial or Web Bluetooth to the
node, the way `RfBrowser.tsx` reaches Meshtastic today; it depends on the node's serial and BLE
protocols, which are listed under open questions.

## Transmit

Sending is off by default and gated on callsign control-verification, like every other transmit path.
On top of that gate:

- **Replies** — the Messages surface answers a direct message through `{"type":"msg","dst":…}` on the
  same socket.
- **Group announcements** (a new cache near the group's region) are opt-in per group and rate-limited.
  An SF11 / 250 kHz frame is long on air and the channel is shared, so the default is no group traffic.
- **Logging a find over the mesh** — a direct message such as `FOUND <cache-id>` to the instance
  callsign logs a find without a web session, the MeshCom counterpart of the over-APRS logging path. A
  standalone T-Deck makes this a phone-free field workflow. The find is attributed through the account
  that owns the verified callsign, never the bare call string.

## Positions that already arrive

Nodes running `--track on` beacon on the LoRa-APRS frequency, and LoRa-APRS IGates forward those
beacons to APRS-IS. They reach every instance today through the existing APRS-IS feed, as ordinary
Tier C positions, with no MeshCom-specific code. The listener adds what that path cannot: MeshCom-only
nodes, messages, telemetry, and signal reports from the operator's own node.

## Open questions

- **Serial and BLE protocols.** Whether the node's serial console emits machine-readable frames, and
  what the BLE service the phone apps use looks like. Both are answered from the MIT firmware source
  before a browser-direct path is designed.
- **Acknowledgements.** How the node reports an ACK for a message sent over UDP, so the Messages
  surface can show delivery once transmit exists.
- **Gateway server protocol.** Whether an instance should ever talk to the MeshCom servers directly;
  the default answer is no — the local node is the integration point.
- **Reference clients.** [MeshcomWebDesk](https://github.com/DH1FR/MeshcomWebDesk) and
  [meshcom-udp-logger](https://github.com/audric/meshcom-udp-logger) are useful behavioural references
  for the UDP interface. Their code is not reused; the ICSSW interface description and the firmware are
  the specifications.

## References

- [ICSSW — MeshCom](https://icssw.org/meshcom/) · [MeshCom 4.0 FAQ](https://icssw.org/en/meshcom-4-0-faq/)
- [MeshCom protocol](https://icssw.org/en/meshcom-2-0-protokoll/)
- [UDP interface for external client software](https://icssw.org/en/udp-schnittstelle-fuer-externe-client-software/)
- [MeshCom & LoRa-APRS](https://icssw.org/en/2026/06/10/meshcom-lora-aprs/)
- [MeshCom firmware (MIT)](https://github.com/icssw-org/MeshCom-Firmware)
- [ÖVSV wiki — MeshCom](https://wiki.oevsv.at/wiki/MeshCom)
- [DARC — Einstieg in MeshCom auf 433 MHz (PDF)](https://www.darc.de/fileadmin/filemounts/distrikte/h/Mesh/Einstieg_in_Meshcom_auf_433_MHz.pdf)
