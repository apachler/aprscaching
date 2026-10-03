# Caches on the MeshCom map (research)

!!! note "Research"
    Nothing on this page is built. It records what is known about the reference MeshCom handheld and how
    caches could appear on its map, separates verified facts from open questions, and holds ready-to-file
    upstream proposals. The backlog items are tracked in
    [`TODO.md`](https://github.com/apachler/aprscaching/blob/dev/TODO.md) under the MeshCom transport.

Showing caches on a map is display only. It never counts as evidence for a find: verification follows the
tiers in [Verification tiers](../../reference/trust-model.md#verification-tiers), and transport is never trust.

## Reference device: LilyGO T-Deck Plus

**Hardware.** ESP32-S3 (dual-core LX7), SX1262 LoRa radio, a GPS receiver, keyboard, trackball, a 2.8″ colour
TFT (320 × 240), Li-ion battery and an ABS case. It is also sold with an external antenna (Amazon ASIN
B0FBGWCVPG).

**MeshCom support.** The ICSSW web flasher ([esptool.oevsv.at](https://esptool.oevsv.at)) lists the board as
"T-Deck, T-Deck-Plus". To enter flash mode: switch the device off, hold the trackball down, switch it on, then
release the trackball.

**Frequency.** Buy the **433 MHz** variant: the D-A-CH MeshCom network runs on 433.175 MHz. The firmware has an
868 MHz profile (869.525 MHz), but an 868 MHz device can use only that profile, which does not reach the
network. The preinstalled firmware (Meshtastic or LILYGO's) does not matter, because the device is reflashed.

**Not the T-Deck Pro.** The T-Deck Pro has a 3.1″ e-ink display and its own firmware variant (`t_deck_pro`).
The T-Deck Plus is the original T-Deck hardware, colour TFT included, with GPS, battery and case added. It
has its own firmware variant (`t_deck_plus`) and MeshCom hardware id 46; the T-Deck is id 8.

**MeshCom user interface on the colour TFT** (per the ICSSW guide and release notes):

- a tabbed interface, including a send tab (*SND*) and a settings tab (*SET*);
- a map view that opens at the last saved position, with *+* / *−* zoom icons;
- a GPS panel with satellite count and HDOP;
- keyboard shortcuts for backlight and screen (ALT+B, SYM+K, SYM+L);
- optional sounds played from the SD card; setup data is also stored on the SD card.

**Recent T-Deck Plus work** (firmware 4.35s–4.35t): a Kalman filter on GPS positions, key repeat on the
keyboard, faster boot, and a sound/mute fix. Firmware 4.35t also fixes screen rendering that stopped part-way
through an update ([MeshCom-Firmware #1131](https://github.com/icssw-org/MeshCom-Firmware/issues/1131)), so a
T-Deck Plus for this map runs 4.35t or later. The current release is 4.40a (October 2026).

### How the map works

From the firmware source, release 4.40a:

- **Tiles from the SD card.** The map draws raster tiles from up to five map sets in
  `/maps/<set>/<z>/<x>/<y>.png`: the OSM slippy-map layout, 256-pixel PNG tiles, Web Mercator. Each set's zoom
  range comes from its folders. The firmware downloads and renders no tiles itself; the operator copies them
  onto the card, and the settings tab picks the set. Without a card the map says so.
- **Rendering.** LVGL 8.3 on TFT_eSPI. A redraw decodes at most 2 × 2 tiles with lodepng into one image of the
  viewport (about 294 × 182 pixels). There is no tile cache, so every pan or zoom reads the card again.
- **Stations.** Each one is a red dot (blue for the node itself) with its callsign as the label; there is no
  APRS symbol, comment or age. They sit in a ring of 30 entries shared by all stations. Once it is full, new
  stations replace entries 1–29 in turn; entry 0 stays. Entries do not expire.
- **What feeds it.** Only position frames received over LoRa, labelled with the sender's callsign. Positions
  that reach a gateway node over UDP or the internet do not appear.
- **Memory.** The board has 8 MB of PSRAM and LVGL allocates from it, so memory is not what limits an
  overlay. The 30-entry ring is.
- **Southern and western positions plot in the wrong place.** The function that adds a station negates the
  latitude for `W` and the longitude for `S`, the letters swapped, so neither is ever negated. The position
  list has the same swap. Positions in Europe are unaffected. A fix is drafted below
  ([Draft: southern and western positions](#draft-southern-and-western-positions-on-the-t-deck-map)).

## Why caches cannot be pushed onto the map

None of the firmware's client interfaces can place a point of its own on the node's map:

- **ExtUDP** (JSON over UDP, port 1799) accepts text messages (`{"type":"msg","dst":…,"msg":…}`) and sensor
  values for the node's own beacon (`{"type":"tele",…}`). It cannot inject positions or objects. See the
  [ExtUDP reference](../../reference/meshcom-extudp.md).
- **KISS over TCP** (port 8001, ESP32 only;
  [MeshCom-Firmware #1151](https://github.com/icssw-org/MeshCom-Firmware/pull/1151)) is in the firmware from the
  4.35t daily build of 24 September 2026 and in 4.35u and later, off by default. It converts a client's
  AX.25 frames into MeshCom text or position messages, at most 8 per second, and refuses anything else as a
  bad frame. A frame must come from the client's base callsign; any SSID passes. A client transmits only
  with `--kiss tx on` as well; `--kiss auth on` adds an HMAC challenge keyed with the node password, which a
  standard KISS client does not answer.
- **Bluetooth** (the phone app) configures the node — callsign, symbol, its own position, Wi-Fi, time and
  `--` commands — and sends text messages. Nothing it sends places a point of its own on the map.

The map cannot show a received APRS object either. MeshCom has no object or item frame: the firmware takes
text (`:`), position (`!`) and HEY (`@`) frames plus its own binary ack frame (`0x41`), and discards anything
else, so an object never reaches the node.

A client could send positions under extra SSIDs of its own call, and each would show as a dot labelled
`OE8APR-1` and so on. APRScaching does not use this: gateways forward those frames to APRS-IS as station
positions that are not real, and the label cannot be a cache code.

## Concept: three layers, one overlay renderer

**1. Text bot — works with current firmware (4.40a).** An operator sends `CACHES [grid]` to a bot callsign and
receives the nearest caches in one reply within the message limit. Without a grid, the bot uses the sender's
last beaconed position. It rides the gateway → box transmit channel described in [Logging finds over radio
messages](radio-find-logging.md).

**2. SD-card POI layer — upstream feature.** The firmware loads a GPX or CSV waypoint file from the SD card
and draws it as a map overlay; APRScaching provides a GPX export per region or Maidenhead grid square.

- It works offline and costs no airtime.
- It is generic — repeaters, SOTA summits, shelters — so upstream acceptance is likely.

**3. On-demand APRS objects — upstream feature.** On request, the bot answers with the nearest three to five
caches as APRS objects (object name = cache code, originator = the bot's callsign). This needs two firmware
changes:

- MeshCom gains an object frame type, and the firmware receives objects and shows them on the map, honouring
  an expiry time and kill frames;
- KISS accepts object frames whose originator is the client's own callsign.

Objects are broadcasts that every mesh node repeats. They are therefore sent **only on request**, with a
rate limit and a per-area cooldown, and **never as a periodic beacon**. Other nodes' maps show them too,
which is likely welcome visibility.

Layers 2 and 3 share one overlay renderer: the SD card supplies the static offline set, objects supply
dynamic additions such as new caches or events.

## Working with upstream

- Agree each concept with ICSSW (forum or an issue) **before** writing firmware code.
- The KISS interface was first merged as
  [#1114](https://github.com/icssw-org/MeshCom-Firmware/pull/1114), reverted shortly after without a
  stated reason, and resubmitted as [#1151](https://github.com/icssw-org/MeshCom-Firmware/pull/1151).
- Community contributions are merged — for example
  [#1157](https://github.com/icssw-org/MeshCom-Firmware/pull/1157) (DK5EN).

## Open questions

| Question | Status | How to settle it |
|---|---|---|
| Does the T-Deck map show received APRS objects? | **Settled: no** — MeshCom has no object frame; the firmware discards every frame but text, position, HEY and its own ack frame (firmware 4.40a) | — |
| Is the message limit counted in bytes or characters? | **Settled: 150 bytes of UTF-8** — the firmware checks `strlen`, so an umlaut costs two bytes (firmware 4.35t, see the [ExtUDP reference](../../reference/meshcom-extudp.md)) | — |
| How is the map implemented (tiles, SD storage, renderer, memory headroom for an overlay)? | **Settled** — SD-card PNG tiles in the slippy-map layout, LVGL 8.3, memory in PSRAM; the 30-station ring is the limit ([How the map works](#how-the-map-works)) | — |
| How much heap and PSRAM is free with the map open? | **Unverified** | `--heap` on a measurement build of the firmware, on a T-Deck Plus |

## Upstream proposal drafts

Ready to file on [icssw-org/MeshCom-Firmware](https://github.com/icssw-org/MeshCom-Firmware/issues) once the
concept is agreed with ICSSW. **Not filed.**

### Draft: map overlay of waypoints from the SD card

> **Title:** Map: show a waypoint overlay loaded from the SD card (GPX / CSV)
>
> **Problem.** The map shows stations heard on the mesh, but an operator in the field often wants fixed
> points of interest on the same screen — repeaters, SOTA summits, shelters, meeting points, geocaches.
> The map draws only SD-card tiles and stations heard over LoRa, so these points can only be sent as text.
>
> **Proposed behaviour.** At boot (and on a menu action), the firmware reads one waypoint file from the SD
> card, for example `/maps/poi.gpx` or `/maps/poi.csv` beside the tile sets, and draws each point as a small
> symbol with an optional short label on the same projection as the stations. The points live in their own
> table, apart from the 30-station ring, so they never push a station off the map. A settings switch turns the
> overlay on or off. Points outside the visible area are skipped; nothing is transmitted.
>
> **File format.**
>
> - *GPX subset:* `<wpt lat="…" lon="…">` with `<name>` (label, truncated to 9 characters) and optional
>   `<sym>` / `<type>`; everything else ignored.
> - *CSV:* `lat,lon,label,symbol` — decimal degrees, label up to 9 characters, symbol an APRS symbol pair
>   (`/;`) or empty for a default. `#` starts a comment line.
>
> **Memory and airtime.** No airtime at all. Points are loaded into a compact array in PSRAM (lat/lon as
> 32-bit integers, 9-byte label, 2-byte symbol ≈ 20 bytes per point), capped at a fixed count (for example
> 500), and filtered per redraw by the visible bounding box. The vendored tinyxml2 library can parse the GPX.
>
> **Why it is generic.** Any group benefits: repeater lists, summit lists for SOTA activators, emergency
> shelters for EmComm exercises, event locations. The file can be produced by any tool that exports GPX.
>
> **Offer.** We can contribute the implementation and test it on a T-Deck Plus (433 MHz).

### Draft: receive and show APRS objects on the map

> **Title:** Map: display received APRS objects with expiry and kill support
>
> **Problem.** APRS objects (`;NAME_____*DDHHMMz…`) are the standard way to announce a point that is not a
> station — an event, a net control position, a temporary repeater. MeshCom has no object frame: the firmware
> accepts text, position and HEY frames plus its own binary ack frame and discards anything else, so objects
> never reach a MeshCom handheld.
>
> **Proposed behaviour.** A new MeshCom frame type carries an APRS object. When the node receives one, it
> stores it keyed by (originator, object name) and draws it on the map with its symbol and name. A later object with the same key replaces the
> earlier one; a kill frame (`_` instead of `*` after the name) removes it. Each object expires after a
> configurable time (default 60 minutes) unless refreshed.
>
> **Frame format.** APRS101 chapter 11: object name 9 characters, live/killed flag, timestamp,
> uncompressed or compressed position, symbol table and code, optional comment.
>
> **Memory and airtime.** Display only — no extra transmissions. A bounded table (for example 50 objects,
> oldest evicted first) keeps memory predictable on the ESP32-S3.
>
> **Why it is generic.** Objects are used by events, public-service nets, EmComm and APRS gateways; showing
> them makes MeshCom handhelds more useful in mixed APRS/MeshCom operation.
>
> **Offer.** We can contribute the implementation and test it on a T-Deck Plus (433 MHz).

### Draft: transmit APRS object frames through the KISS interface

> **Title:** KISS: allow APRS object frames whose originator is the client's callsign
>
> **Problem.** The KISS/TCP interface (#1151) converts client frames only into text or position messages
> and refuses anything else. A client application that wants to announce a point — for example the nearest
> caches in answer to a request — has no way to send it as an object.
>
> **Proposed behaviour.** Accept an AX.25 UI frame whose information field is an APRS object when the
> frame's source (the object's originator) is the client's own callsign, and transmit it as a MeshCom
> object message, the frame type the object proposal above defines. The existing own-callsign check and rate limit stay in force; object frames count
> against the same rate limit.
>
> **Frame format.** As received: APRS101 chapter 11 object, including kill frames so a client can withdraw
> an object it announced.
>
> **Memory and airtime.** No new buffers. Objects are broadcasts repeated by every node, so the interface
> should keep them clearly on-demand: the existing rate limit plus, optionally, a lower limit for object
> frames specifically (for example 1 per 10 s).
>
> **Why it is generic.** Any KISS client — APRS software, event tooling, net-control helpers — can then
> place objects on MeshCom maps under its operator's own callsign.
>
> **Offer.** We can contribute the implementation and test it on a T-Deck Plus (433 MHz).

### Draft: southern and western positions on the T-Deck map

> **Title:** T-Deck map and position list: southern latitudes and western longitudes are never negated
>
> **Problem.** `tdeck_add_pos_point()` (`src/t-deck/lv_obj_functions.cpp:3800-3806`) and
> `tdeck_add_to_pos_view()` (`:3983-3989`) negate the latitude when `lat_c == 'W'` and the longitude when
> `lon_c == 'S'`. The caller in `src/lora_functions.cpp` passes unsigned degrees with `lat_c` as `N`/`S` and
> `lon_c` as `E`/`W`, so neither test ever matches. A station south of the equator or west of Greenwich is
> drawn at the mirrored position on the map and listed with the wrong sign in the position view. Stations in
> Europe east of Greenwich are unaffected, which is why it goes unnoticed. Seen in release 4.40a (`e1e2ace`).
>
> **Proposed fix.** In both functions, test the letter that belongs to each axis:
>
> ```cpp
> if(lat_c == 'S')
>     dlat = u_dlat * -1.0;
>
> if(lon_c == 'W')
>     dlon = u_dlon * -1.0;
> ```
>
> The other caller, the test command `--injectpos` in `src/command_functions.cpp`, already passes `S` and `W`
> this way, so its southern and western positions plot correctly with the same change.
>
> **Memory and airtime.** None; a two-character change in each function.
>
> **Offer.** We can test the fix on a T-Deck Plus (433 MHz) with `--injectpos` positions in all four
> hemispheres.

## Sources

- ICSSW T-Deck guide: <https://icssw.org/en/t-deck-anleitung/>
- ICSSW MeshCom release notes: <https://icssw.org/en/meshcom-versionen/>
- ICSSW ExtUDP interface description: <https://icssw.org/en/udp-schnittstelle-fuer-externe-client-software/>
- ICSSW web flasher: <https://esptool.oevsv.at>
- MeshCom firmware: <https://github.com/icssw-org/MeshCom-Firmware> — issue
  [#1131](https://github.com/icssw-org/MeshCom-Firmware/issues/1131), pull requests
  [#1114](https://github.com/icssw-org/MeshCom-Firmware/pull/1114),
  [#1151](https://github.com/icssw-org/MeshCom-Firmware/pull/1151),
  [#1157](https://github.com/icssw-org/MeshCom-Firmware/pull/1157)
- MeshCom firmware source, release 4.40a (`e1e2ace`): `src/t-deck/tdeck_sdmap.cpp` (tiles),
  `src/t-deck/lv_obj_functions.cpp` (stations on the map), `src/aprs_functions.cpp` (accepted frames),
  `src/extudp_functions.cpp`, `src/kiss_functions.cpp`, `src/phone_commands.cpp`
- APRS Protocol Reference (APRS101), chapter 11 "Object and Item Reports"

## Next

- [MeshCom integration (design)](meshcom.md): how the platform talks to MeshCom.
