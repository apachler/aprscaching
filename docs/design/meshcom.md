# MeshCom integration (design)

!!! note "Built and planned"
    The receive side is built: the pure core in `packages/aprs/src/meshcom/` decodes the datagrams,
    `apps/ingest/src/meshcom.ts` listens for them, and operator setup is under
    [MeshCom](../operate/meshcom.md). Transmit is built for one use: answering radio commands heard on
    the mesh (see [Transmit](#transmit)). Telemetry, replies from the Messages surface, and a
    browser-direct path are planned, tracked in
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
| Addressing | Direct message to a callsign, group message to a group number `1`–`99999` (group 9 = emergency), broadcast to `*` |
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

- A client sends with `{"type":"msg","dst":"<call | group | *>","msg":"<text>"}` (UTF-8, at most 150
  **bytes**). The full datagram set, verified against the firmware, is the
  [ExtUDP reference](../reference/meshcom-extudp.md).
- `lat`/`long` are unsigned degrees (truncated to four decimals) with the hemisphere in
  `lat_dir`/`long_dir`. `alt` holds the raw `/A=` digits, which are feet or metres depending on a
  per-node setting, so the listener does not forward it.
- `src_type` names where the node got the datagram: `lora` (heard on air), `node` (the node itself),
  `udp` (relayed from the MeshCom server over the internet).
- The trailing `{034` on a message is the APRS message number, used for acknowledgement.
- The interface carries **no authentication and no encryption.**

## How it fits the platform

MeshCom sits between APRS and Meshtastic. Like APRS it carries real callsigns on every frame and APRS
payloads, so a MeshCom position maps onto a station directly — Meshtastic shows a
callsign only for nodes in licensed mode, learned from their node info. Like Meshtastic it is a LoRa mesh reached through a node on the operator's
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
| Pure core | `packages/aprs/src/meshcom/`: `parse` (total, structured rejection reasons), `normalize` (hemisphere, callsigns, path, locator, provenance), `dedup` (bounded frame-id window, stronger copies upgrade), `encode` (direct-callsign text, 150 UTF-8 bytes), `aprs` (APRS mapping and transport hint). A position becomes an uncompressed `!` position; a direct message an APRS `:ADDRESSEE:text{nnn` message; group and `*` text an APRS user-defined `{MG` packet, which the decoder classifies as `other` so it stays out of the message log. Conformance runs the golden fixtures on Node, Bun and workerd (`pnpm conformance:meshcom`) | built |
| UDP listener | `MeshcomListener` in `apps/ingest/src/meshcom.ts`: accepts only configured node addresses, bounds size and per-node rate, passes raw datagrams to `MESHCOM_FANOUT` targets, dedups, stamps the transport hint, logs counters and warns on a silent node or crash-prone firmware. Never in the Worker bundle (`tools/checks/worker-bundle.mjs`) | built |
| Configuration | `MESHCOM_NODE` (`ip[=CALL]` list; enables the listener), `MESHCOM_PORT`, `MESHCOM_BIND`, `MESHCOM_FANOUT`, `MESHCOM_RATE`, `MESHCOM_STALE_MIN` | built |
| Transport enum | `"meshcom"` in `Transport` (`packages/shared/src/packet.ts`). Stored positions record it in `positions.transport`, which `transportOf()` in `workers/gateway/src/provenance.ts` reads back; display and statistics only, since trust gates on the attestation flag, not the transport | built |
| Positions | `kind:"position"` with `parsed.lat/lon` → live map, MHeard, `GET /api/ports` | built |
| Messages | a direct message → the messages log (`shack.ts`); the Messages surface shows it | built |
| Node and link store | `meshcom_nodes` and `meshcom_links` (`workers/gateway/src/meshcom.ts`): per node the latest device, firmware, battery, way of hearing, receiver and a rolling signal average; per link the last direct hearing or relay leg. Written only from the operator's own attested MeshCom port, when something shown changes or `MESHCOM_META_MIN_S` has passed; pruned nightly, skipped while the write budget sheds. Display only: never touches the A/B/C find tiers | built |
| Read API | `GET /api/meshcom/nodes` and `GET /api/meshcom/links` ([API](../reference/api.md)): buckets for visitors, exact battery, RSSI and SNR for signed-in members | built |
| Map | a MeshCom layer (on by default) marks nodes with an "M" tag, dashed when heard only via the server; a links sub-layer (off by default) draws the last 24 hours of links, solid for direct, dashed for relay legs, wider for a stronger signal, fainter with age; the station panel shows how the node was heard, its device, battery and signal, and links to its page on [MeshMap](https://meshmap.oevsv.at/). Device names come from a table of the firmware's hardware ids (`packages/aprs/src/meshcom/hardware.ts`) | built |
| Via lists | the destination is the last token of `dst`; the via list rides as display metadata (`sent_via` on the node row) and never becomes a link or a trust input ([Via-Calls](#via-calls)) | built |
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

- **Only a direct LoRa hearing names a receiving site.** A frame is RF only when `src_type` is `lora`
  and its origin is not the receiving node (the firmware labels the node's own back-pressure notices
  `lora`). An RF frame whose source path is the originator alone is *direct*. The listener forwards a
  direct frame as `heardVia: "rf"` with the node's call as `igateCall`; a relayed RF frame as `rf` with no
  gate; everything else as `aprs_is`, all on the `meshcom` port. The gateway's provenance derivation is
  then the only Tier-A gate: `meshcom` is one of the two on-air transports it can attest (with a local
  TNC), and it attests the frame only when the node's call is in `FIRST_PARTY_SITES`, and the usual
  independence rule stops an operator's own node from corroborating the operator's own find.
- **Relayed and server frames never corroborate presence.** A relay proves the originator was near the
  relay, not near the receiving node, and a server copy proves nothing about the air.
- **Finds logged over the mesh** ([Logging finds over radio messages](radio-find-logging.md)) stay Tier C unless corroborated by the usual A or B
  evidence; the message itself proves nothing about presence.

## Security

- The listener binds to the LAN (`MESHCOM_BIND`) and drops datagrams whose source address is not
  `MESHCOM_NODE`. Any host on the segment can otherwise inject JSON.
- Port 1799 is never exposed to the internet. Pointing `--extudpip` at a cloud gateway would couple RF
  ingest to a cloud host and send unauthenticated traffic across the internet; the operator docs say so
  explicitly.
- Datagrams over 2 KiB are refused before parsing; every field is type- and range-checked, text is
  collapsed to one line and length-bounded, and a malformed datagram is dropped, never thrown.
- The listener never transmits and never registers with the node, so it cannot change the node's
  state.

## Locality

The node talks to the ingest box over the operator's own LAN, which is exactly the shape
[the ingest-locality rule](https://github.com/apachler/aprscaching/blob/dev/.claude/rules/ingest-locality.md)
asks for: a Pi next to the node works off-grid with a local gateway, and the same box can forward to a
LAN or cloud gateway through `INGEST_URL`.

The browser cannot open UDP sockets. A browser-direct path goes over Web Serial or Web Bluetooth to the
node, the way `RfBrowser.tsx` reaches Meshtastic; it depends on the node's serial and BLE
protocols, which are listed under open questions.

## Transmit

`MeshcomSender` (`apps/ingest/src/meshcom-send.ts`) is the one transmit path. It is off unless enabled
with the operator's callsign, and that call must match the call the target node transmits under — the
node sends every message as itself, so software can only transmit under the licensed operator's call.
It sends direct messages to a callsign only (the encoder refuses groups and `*`), only to configured
node addresses, through a token bucket (one per minute, burst three, by default) because an SF11 /
250 kHz frame is long on air and the channel is shared. Every attempt is audited — time, node,
destination, byte length, requesting feature and outcome, never the text. ExtUDP has no
acknowledgement, so the best outcome is *handed to node*; the node reports its own refusals
(`QRS`/`QRT`) back through the listener.

The box enables the sender with `MESHCOM_TX=1`. It is used by:

- **Answers to radio commands** — the ack and opt-in reply to a `FOUND` / `DNF` / `NOTE` / `HELP` direct
  message that one of the box's nodes heard, queued by the gateway as a `meshcom_msg` box command
  ([Logging finds over radio messages](radio-find-logging.md)).

Planned: **replies** from the Messages surface answering a direct message, tracked in
[`TODO.md`](https://github.com/apachler/aprscaching/blob/dev/TODO.md).

Group announcements stay out of scope: software never originates group or broadcast traffic.

## Via-Calls

A node can name the relays allowed to forward what it sends, instead of letting every node flood it — source
routing to save airtime (firmware v4.35p.06.13: "DESTINATION-PATH expanded to include VIA-CALLS").

- **Commands.** `--via <CALL,CALL>` sets the list (upper-cased, at most 39 characters), `--via NONE` clears
  it, `--via on|off` switches the function, `--viadebug on|off` adds debug output. The node settings show
  the list as `VIACALL`.
- **Sending.** With Via on and a list set, `checkVia()` writes the destination path as
  `<via-list>,<destination>` on every send path, messages that arrive from an ExtUDP client included.
- **Relaying.** A frame without a via list is relayed by every node with `--mesh on`. A frame with one is
  relayed only by a node whose call appears in it — compared token by token at full length, so `DK5EN-9`
  is not `DK5EN-90` — and only if that node has `--mesh on`. Order is not enforced: any named node that
  hears the frame relays it. Every node still receives it.
- **Automatic selection** (the gateway token `HG`, or the best-connected MHeard neighbour) is commented out
  in the firmware since 22 July 2026; only lists an operator sets take effect.

Three rules hold in aprscaching:

1. **The destination is the last token** of `dst`, everything before it the via list
   ([ExtUDP](../reference/meshcom-extudp.md#text-type-msg)).
2. **A via list is never a link.** The map draws links from the source path and the receiving node only;
   a via list names relays the sender allowed, not ones the frame passed.
3. **A via list is never trust.** It bears on nothing in provenance, `direct` or the A/B/C tiers. It is
   display information: the station panel shows a node's latest list ("sent via relays …"), and the
   operator's own node's list — which every message the box sends through it carries — shows in the
   station status, the Pocket notification and the box log.

Sources: firmware [`1d4f525`](https://github.com/icssw-org/MeshCom-Firmware/tree/1d4f5250d8ee5a7d136f6b8d03e15374392775f8) — `src/via_functions.cpp` (`checkVia`, `checkMesh`, `pathNamesCall`),
`src/command_functions.cpp` (`--via`), `src/aprs_functions.cpp` (the destination split),
`src/extudp_functions.cpp` (`dst`), `docs/hey-supp.md` (the routing design).

## Positions that already arrive

Nodes running `--track on` beacon on the LoRa-APRS frequency, and LoRa-APRS IGates forward those
beacons to APRS-IS. They reach every instance through the APRS-IS feed, as ordinary
Tier C positions, with no MeshCom-specific code. The listener adds what that path cannot: MeshCom-only
nodes, messages, telemetry, and signal reports from the operator's own node.

## Open questions

- **Serial and BLE protocols.** Whether the node's serial console emits machine-readable frames, and
  what the BLE service the phone apps use looks like. Both are answered from the MIT firmware source
  before a browser-direct path is designed.
- **Acknowledgements.** How the node reports an ACK for a message sent over UDP. ExtUDP carries none, so
  a transmitted message ends at *handed to node* and the Messages surface cannot yet show delivery.
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
