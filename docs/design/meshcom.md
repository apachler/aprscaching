# MeshCom integration (design)

!!! note "Design proposal"
    This page is a design for a transport that is not built. Nothing on it is configurable today; the
    work is tracked in [`TODO.md`](https://github.com/apachler/aprscaching/blob/dev/TODO.md). Once a
    piece lands, its operator-facing description moves to [RF ingest & transports](../operate/rf-ingest.md)
    and this page shrinks to the reasoning behind it.

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
{"src_type":"lora","type":"pos","src":"OE1KBC-12","lat":48.2,"lat_dir":"N","long":16.37,"long_dir":"E","aprs_symbol":"#","alt":180,"batt":87,"hw_id":3}
{"src_type":"node","type":"tele","src":"OE1KBC-12","temp1":9.9,"hum":61.0}
```

- A client registers with `{"type":"info","src":"<CALL-SSID>"}` and sends with
  `{"type":"msg","dst":"<call | group | *>","msg":"<text>"}` (UTF-8, at most 150 characters).
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

| MeshCom piece | Home in the repo |
|---|---|
| JSON → `Packet` decode | `packages/aprs/src/meshcom.ts` — a pure `parseMeshcomUdp()` beside `meshtastic.ts`, with unit tests from captured datagrams |
| UDP listener | `apps/ingest/src/meshcom.ts` — a `dgram` listener shaped like `cotlisten.ts` (rebind on `EADDRINUSE`), registered env-gated in `apps/ingest/src/index.ts` |
| Configuration | `MESHCOM_PORT` (default 1799), `MESHCOM_BIND`, `MESHCOM_NODE` (the node's IP; datagrams from any other source are dropped), `MESHCOM_CALL` (the `info` registration call) in `.env.example` and `docs/reference/configuration.md` |
| Transport enum | `"meshcom"` in `Transport` (`packages/shared/src/packet.ts`), mapped in `transportOf()` (`workers/gateway/src/provenance.ts`) |
| Positions | `pos` → `kind:"position"` with `parsed.lat/lon`, which `fixOf()` in `workers/gateway/src/ingest.ts` already consumes → live map, MHeard, `GET /api/ports` |
| Messages | `msg` addressed to the instance callsign → the Messages surface; `msg` to a group or `*` → the port monitor only |
| Telemetry | `tele` → the observational weather path; never touches the A/B/C find tiers |
| Operator docs | A **MeshCom** row in the transports table of [RF ingest & transports](../operate/rf-ingest.md), a row in the [specification registry](../reference/specs.md) |

### Callsigns and paths

`src` is a source path. The origin is its first element; later elements are the relaying nodes and go
into `Packet.path`. The callsign parser accepts SSIDs outside the AX.25 0–15 range, as APRS-IS already
does for TNC2 text.

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
- Every field is length-bounded and validated with zod before it becomes a `Packet`; a malformed
  datagram is dropped and counted, never thrown.

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
- **`src` path order.** Confirm against captured traffic that the origin is the first element and
  relays follow.
- **Acknowledgements.** How the node reports an ACK for a message sent over UDP (a `type` value, or an
  ack `msg`), so the Messages surface can show delivery.
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
