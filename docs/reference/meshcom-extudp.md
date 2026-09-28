# MeshCom ExtUDP protocol

A MeshCom node streams the frames it handles to one host on its LAN as JSON over UDP, and accepts text
messages from that host for LoRa transmission. This page is the platform's reference for that interface.
It is verified against the MeshCom firmware source rather than the published description, because the
two differ (see [Differences from the ICSSW description](#differences-from-the-icssw-description)).

**Verified against:** MeshCom firmware 4.35t — `icssw-org/MeshCom-Firmware` `main` at `cf215b5`
(2026-09-26) and `dev` at `c540761` (2026-09-28); the ExtUDP emitters (`src/extudp_functions.cpp`,
`src/extern_tele_json.h`, `src/extern_notice_json.h`) are identical on both branches.
The firmware is MIT-licensed.

Golden fixtures for every shape below live in `packages/aprs/test/fixtures/meshcom/`.

## Transport

- UDP, node port **1799** (`EXTERN_PORT`, fixed in firmware). The node sends to the address set with
  `--extudpip` on port 1799 and receives on its own port 1799.
- One JSON object per datagram, UTF-8. The node's output buffer is 500 bytes.
- No authentication, no encryption, no sequencing, no acknowledgement. Datagrams can be lost, duplicated
  or spoofed by any host that can reach the port.
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
`aprs_symbol_group`, `hw_id`, `msg_id`, `alt`, `batt`, `firmware`, `fw_sub`, `rssi`, `snr`.

- `lat` / `long` are **unsigned** decimal degrees, truncated to four decimals; the sign comes from
  `lat_dir` (`N`/`S`) and `long_dir` (`E`/`W`). A node without a fix reports `0`/`0`.
- `aprs_symbol` is the symbol code, `aprs_symbol_group` the table (`/` or `\`). A backslash is doubled
  before serialisation, so the JSON string holds two; the first character is the symbol.
- `alt` is the integer after the frame's `/A=`. The sending node writes feet or metres depending on its
  own setting, so the unit cannot be known from the datagram.
- `batt` is 0–100 %.

### Text (`type: "msg"`)

`src_type`, `type`, `src`, `dst`, `msg`, `msg_id`, `firmware`, `fw_sub`, `rssi`, `snr`.

- `dst` is `*` (everyone), a group number (`1`–`99999`; group 9 carries emergency traffic), or a callsign
  with optional SSID.
- `msg` is UTF-8. A direct message may end in an APRS message number (`Hello{034`).
- A direct message neither to nor from the node is suppressed when the node runs `--nopmother on`.
- Telemetry frames addressed to `100001` are never forwarded as text.

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

- `dst`: 1–9 **bytes**; `*`, a group number, or any other address — a callsign, or a service address such as `APRSCG`. The firmware does not check the destination against a callsign pattern.
- `msg`: 1–150 **bytes** of UTF-8 (the firmware checks `strlen`, so an umlaut costs two bytes and an
  emoji four). A `NUL` in either field rejects the datagram.
- Invalid JSON, a missing field, or a length outside the limits is dropped silently.
- `{"type":"tele", "temp":…, "hum":…, "press":…, "temp2":…, "qnh":…, "gasres":…, "co2":…}` sets the
  node's own sensor values instead of sending text.
- The node frames the text as `:{<dst>}<msg>` and transmits it under its own callsign.

## Node setup

```
--setssid <SSID>
--setpwd <PASSWORD>
--extudpip <client IP>      # or 255.255.255.255 for LAN broadcast
--extudp on
```

## Firmware versions

The node's own frames carry `firmware: "4.35"` and `fw_sub: "t"`; received frames carry the sender's
number and letter. No build date is included. The firmware fix for the ESP32 loop-task stack overflow with
`--extudp on` (MeshCom-Firmware pull request #1157, merged 2026-09-25) landed within 4.35t, so:

- older than 4.35t → affected;
- 4.35t → affected if built before 2026-09-25, which the datagram cannot tell;
- newer → not affected.

## Differences from the ICSSW description

The [published description](https://icssw.org/en/udp-schnittstelle-fuer-externe-client-software/) is
approximate. Against the firmware:

| Published | Firmware |
|---|---|
| Examples use typographic quotes and misplaced braces | Plain JSON as shown on this page |
| `src_type: node` includes LoRa reception | `node` is the node's own traffic; LoRa reception is `lora` |
| `lora` means heard over LoRa | Also used for the node's own back-pressure notices |
| `alt` in metres | Raw `/A=` value, feet or metres per the sending node's setting |
| `msg` up to 150 characters | Up to 150 **bytes** |
| Telemetry keys `temp1`, `hum` | Full key set above, including `qfe`/`qnh`, `pressure_alt` and `din` |
| — | Clients may send `type: "tele"` to set the node's sensor values |
| — | The symbol table arrives as `aprs_symbol_group`, with a doubled backslash |
| Groups `10`–`99999` | Groups `1`–`99999` (`CheckGroup`); `100001` is reserved for telemetry |
