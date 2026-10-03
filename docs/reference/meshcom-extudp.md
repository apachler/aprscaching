# MeshCom ExtUDP protocol

A MeshCom node streams the frames it handles to one host on its LAN as JSON over UDP, and accepts text
messages from that host for LoRa transmission. This page is the platform's reference for that interface.
It is verified against the MeshCom firmware source rather than the published description, because the
two differ (see [Differences from the ICSSW description](#differences-from-the-icssw-description)).

**Verified against:** MeshCom firmware 4.40a — `icssw-org/MeshCom-Firmware` tag `v4.40a` at `e1e2ace`
(2026-10-02): the ExtUDP emitters `src/extudp_functions.cpp`, `src/extern_msg_json.h`, `src/extern_tele_json.h`,
`src/extern_notice_json.h` and `src/udp_frame.h`. Fields marked 4.40 are absent from older nodes.
The firmware is MIT-licensed.

Golden fixtures for every shape below live in `packages/aprs/test/fixtures/meshcom/`.

## Transport

- UDP, node port **1799** (`EXTERN_PORT`, fixed in firmware). The node sends to the address set with
  `--extudpip` on port 1799 and receives on its own port 1799.
- One JSON object per datagram, UTF-8. A message datagram is built in a 700-byte buffer; the node reads at
  most 254 bytes of an inbound one.
- No authentication, no encryption, no sequencing. Datagrams can be lost, duplicated or spoofed by any host
  that can reach the port. From 4.40 a node reports the acknowledgement of its own direct messages when it
  arrives through the MeshCom server ([Delivery ack](#delivery-ack-type-ack)); an ack heard over LoRa is not
  reported.
- The node does nothing with ExtUDP while it runs its own Wi-Fi access point (`bWIFIAP`); it has to be a
  client on the operator's network.

## Node → client

### Common fields

| Field | Type | Meaning |
|---|---|---|
| `src_type` | string | `lora`, `udp` or `node` — see [Where a frame came from](#where-a-frame-came-from) |
| `type` | string | `pos`, `msg` or `tele` |
| `src` | string | Source path: the originating callsign first, then each relaying node, comma-separated (`9V1LH-1,OE1KBC-12` = 9V1LH-1 heard via OE1KBC-12) |
| `msg_id` | string | Frame id, 8 upper-case hex digits; every copy of one frame carries the same id |
| `firmware` | number or string | Sender firmware: a number (e.g. `35`) for a received frame, the version string (`"4.35"`) for the node's own frames |
| `fw_sub` | string | Firmware sub-version letter (`a`–`z`) |
| `rssi`, `snr` | integer | Signal report; `0` when the frame did not come from the radio |

### Position (`type: "pos"`)

`src_type`, `type`, `src`, `msg` (always `""`), `lat`, `lat_dir`, `long`, `long_dir`, `aprs_symbol`,
`aprs_symbol_group`, `hw_id`, `msg_id`, `alt`, `batt`, `firmware`, `fw_sub`, `rssi`, `snr`, and from 4.40
`lora_mod` and `max_hop`.

- `lat` / `long` are **unsigned** decimal degrees, truncated to four decimals; the sign comes from
  `lat_dir` (`N`/`S`) and `long_dir` (`E`/`W`). A node without a fix reports `0`/`0`.
- `aprs_symbol` is the symbol code, `aprs_symbol_group` the table (`/` or `\`). A backslash is doubled
  before serialisation, so the JSON string holds two; the first character is the symbol.
- `alt` is the integer after the frame's `/A=`. The sending node writes feet or metres depending on its
  own setting, so the unit cannot be known from the datagram.
- `batt` is 0–100 %.

### Text (`type: "msg"`)

`src_type`, `type`, `src`, `dst`, `msg`, `msg_id`, `firmware`, `fw_sub`, `rssi`, `snr`, and from 4.40
`hw_id`, `lora_mod` and `max_hop`.

- `hw_id` is the originating device ([hardware ids](../run/radios/meshcom.md)); `lora_mod` the LoRa modulation
  setting (low nibble); `max_hop` the hop budget left on this copy. APRScaching keeps `hw_id` for display and
  the other two in the raw record.

- `dst` is the whole destination path, `[<via>,…,]<destination>`. The **destination** is the last token:
  `*` (everyone), a group number (`1`–`99999`; group 9 carries emergency traffic), or a callsign with
  optional SSID. The tokens before it are a **via list** (`--via`), the relays allowed to forward this
  copy:

  | `dst` | Destination | Via list |
  |---|---|---|
  | `OE8XYZ-7` | OE8XYZ-7 | — |
  | `OE1KBC-24,*` | everyone | OE1KBC-24 |
  | `OE1KBC-24,OE1KFR-12,262` | group 262 | OE1KBC-24, OE1KFR-12 |
  | `OE1KBC-24,OE8XYZ-7` | OE8XYZ-7 | OE1KBC-24 |
  | `OE1KBC-24,` | none (the frame is rejected) | OE1KBC-24 |

  This is how the firmware's APRS decoder splits it (`msg_destination_call` is the text after the last
  comma, empty after a trailing comma). The firmware does not check via tokens; APRScaching keeps the
  callsigns among them, drops the rest and counts them (`viaDropped`). A via list is a plan, not the route
  the frame took — that is `src`.

- The via list belongs to **the node that last transmitted this copy**, not necessarily to the originator. A
  relaying node resets the destination path to the destination alone and then applies its own via list, if
  it has one; a gateway does the same to a frame it puts on air from the MeshCom server. So `dst` carries the
  originator's via list only when `src` is the originator alone, with no relay calls. Firmware
  [`e1e2ace`](https://github.com/icssw-org/MeshCom-Firmware/tree/e1e2acea6a18285301b57f32caacd0beb62638f2):
  `checkVia()` in `src/via_functions.cpp`, the relay in `src/lora_functions.cpp`, the server-to-LoRa path in
  `src/esp32/udp_frame_esp32.cpp`, the destination split in `src/aprs_functions.cpp`.

- `msg` is UTF-8. A direct message may end in an APRS message number (`Hello{034`).
- A direct message neither to nor from the node is suppressed when the node runs `--nopmother on`.
- Telemetry frames addressed to `100001` are never forwarded as text. The firmware compares the whole path,
  so from a node with Via on telemetry arrives as `<via>,100001`; APRScaching rejects that destination.

### Telemetry (`type: "tele"`)

Sent after a position, as a second datagram. Two shapes share their keys:

| `src_type` | Fields |
|---|---|
| `node` (the node's own sensors) | `src`, `temp1`, `temp2`, `hum`, `qfe`, `qnh`, `gas`, `co2`, optional `din` |
| `lora` (a relayed node's values) | as above, plus `batt` and `pressure_alt` |

`qfe` is station pressure and `qnh` sea-level pressure, both in hPa; `pressure_alt` is the barometric
altitude in metres against 1013.25 hPa; `din` is eight `0`/`1` characters for the MCP23017 inputs and is
omitted when the sender has none. **An absent sensor is reported as `0`**, indistinguishable from a real
zero reading.

### Delivery ack (`type: "ack"`)

```json
{"type":"ack","msg_id":"0A1B2C3D","status":2,"from":"OE1KBC-12","via":"udp"}
```

A 4.40 node sends this when an ack or reject for one of its own direct messages arrives through the MeshCom
server. `msg_id` is the acknowledged message's id, `status` is `1` for the gateway's ack and `2` for the
addressee's, and `from` is omitted when the acknowledging call is not a callsign. It has no `src_type` and is
not a frame: APRScaching counts it (`acks`) and forwards nothing.

### Where a frame came from

| `src_type` | Meaning |
|---|---|
| `lora` | The node received the frame over LoRa — or, for a back-pressure notice, generated it itself (below) |
| `udp` | The MeshCom server relayed the frame to the node over the internet |
| `node` | The node's own frame: a message or position it sent, or its own sensors |

**Back-pressure notices.** When a message sent through ExtUDP cannot go out, the node answers on the same
socket with a `msg` whose `src_type` is `lora`, whose `src` is the node's own callsign, with
`rssi`/`snr` `0` and text such as `QRS`, `QRT NOT SENT - …`, `QTA NOT SENT - …` or `QRV`. It was never on
air. A frame whose origin is the receiving node's own callsign is therefore never an RF observation.

## Client → node

```json
{"type":"msg","dst":"OE1KBC-12","msg":"Test 1 2 3"}
```

- `dst`: 1–9 **bytes**; `*`, a group number, or a callsign. The sending node takes any address, but every
  node that receives the frame drops a direct message whose destination is not callsign-shaped (no digit), so
  an address such as `APRSCG` never arrives.
- `msg`: 1–150 **bytes** of UTF-8 (the firmware checks `strlen`, so an umlaut costs two bytes and an
  emoji four). A `NUL` in either field rejects the datagram.
- Invalid JSON, a missing field, or a length outside the limits is dropped silently.
- `{"type":"tele", "temp":…, "hum":…, "press":…, "temp2":…, "qnh":…, "gasres":…, "co2":…}` sets the
  node's own sensor values instead of sending text. A node with its own BME, BMP, AHT or SHT sensor ignores
  it, so the values a client sends never replace a real reading.
- The node frames the text as `:{<dst>}<msg>` and transmits it under its own callsign. With `--via` on, it
  puts its own via list in front of the destination, as for anything it sends.

## Node setup

```
--setssid <SSID>
--setpwd <PASSWORD>
--extudpip <client IP>      # or 255.255.255.255 for LAN broadcast
--extudp on
```

## Firmware versions

The node's own frames carry the version string and letter, such as `firmware: "4.40"` and `fw_sub: "a"`;
received frames carry the sender's number and letter (`40`, `a`). No build date is included. The firmware fix for the ESP32 loop-task stack overflow with
`--extudp on` (MeshCom-Firmware pull request #1157, merged 2026-09-25) is in 4.35u (2026-09-27) and later.
Every published 4.35t build predates it; a 4.35t built from source after 2026-09-25 has it. So:

- older than 4.35t → affected;
- 4.35t → affected unless built from source after 2026-09-25, which the datagram cannot tell;
- 4.35u or newer → not affected.

## Differences from the ICSSW description

The [published description](https://icssw.org/en/udp-schnittstelle-fuer-externe-client-software/) is
approximate. Against the firmware:

| Published | Firmware |
|---|---|
| Examples use typographic quotes and misplaced braces | Plain JSON as shown on this page |
| `src_type: node` includes LoRa reception | `node` is the node's own traffic; LoRa reception is `lora` |
| `dst` is the destination | `dst` is the destination path: an optional via list, then the destination as the last token |
| `lora` means heard over LoRa | Also used for the node's own back-pressure notices |
| `alt` in metres | Raw `/A=` value, feet or metres per the sending node's setting |
| `msg` up to 150 characters | Up to 150 **bytes** |
| Telemetry keys `temp1`, `hum` | Full key set above, including `qfe`/`qnh`, `pressure_alt` and `din` |
| — | Clients may send `type: "tele"` to set the node's sensor values |
| — | The symbol table arrives as `aprs_symbol_group`, with a doubled backslash |
| Groups `10`–`99999` | Groups `1`–`99999` (`CheckGroup`); `100001` is reserved for telemetry |

## Next

- [MeshCom](../run/radios/meshcom.md): setting up a node.
