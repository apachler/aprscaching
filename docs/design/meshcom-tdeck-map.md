# Caches on the MeshCom map (research)

!!! note "Research"
    Nothing on this page is built. It records what is known about the reference MeshCom handheld and how
    caches could appear on its map, separates verified facts from open questions, and holds ready-to-file
    upstream proposals. The backlog items are tracked in
    [`TODO.md`](https://github.com/apachler/aprscaching/blob/dev/TODO.md) under the MeshCom transport.

Showing caches on a map is display only. It never counts as evidence for a find: verification follows the
tiers in [Core concepts](../concepts.md#verification-tiers), and transport is never trust.

## Reference device: LilyGO T-Deck Plus

**Hardware.** ESP32-S3 (dual-core LX7), SX1262 LoRa radio, u-blox GPS, keyboard, trackball, a 2.8″ colour
TFT (320 × 240), Li-ion battery and an ABS case. It is also sold with an external antenna (Amazon ASIN
B0FBGWCVPG).

**MeshCom support.** The ICSSW web flasher ([esptool.oevsv.at](https://esptool.oevsv.at)) lists the board as
"T-Deck, T-Deck-Plus". To enter flash mode: switch the device off, hold the trackball down, switch it on, then
release the trackball.

**Frequency.** Buy the **433 MHz** variant. MeshCom runs on 70 cm; the 868 MHz variant cannot be used. The
preinstalled firmware (Meshtastic or LILYGO's) does not matter, because the device is reflashed.

**Not the T-Deck Pro.** The T-Deck Pro has a 3.1″ e-ink display and its own firmware variant (`t_deck_pro`).
The T-Deck Plus is the original T-Deck — MeshCom hardware id 8, colour TFT — with GPS, battery and case
added.

**MeshCom user interface on the colour TFT** (per the ICSSW guide and release notes):

- a tabbed interface, including a send tab (*SND*) and a settings tab (*SET*);
- a map view that opens at the last saved position, with *+* / *−* zoom icons;
- a GPS panel with satellite count and HDOP;
- keyboard shortcuts for backlight and screen (ALT+B, SYM+K, SYM+L);
- optional sounds played from the SD card; setup data is also stored on the SD card.

**Recent T-Deck Plus work** (firmware 4.35s–4.35t): a Kalman filter on GPS positions, key repeat on the
keyboard, faster boot, and a sound/mute fix.

**Known issue.** Screen rendering sometimes stops part-way through an update
([MeshCom-Firmware #1131](https://github.com/icssw-org/MeshCom-Firmware/issues/1131), open as of
September 2026).

**Unverified:** how the map is implemented — tile source, whether map data lives on the SD card, the
rendering library, and the memory left for an overlay. See the open questions below.

## Why caches cannot be pushed onto the map

Neither client interface of the firmware can place an arbitrary object on the node's map:

- **ExtUDP** (JSON over UDP, port 1799) accepts only text messages from a client
  (`{"type":"msg","dst":…,"msg":…}`); it cannot inject positions or objects. See the
  [ExtUDP reference](../reference/meshcom-extudp.md).
- **KISS over TCP** (port 8001, ESP32 only;
  [MeshCom-Firmware #1151](https://github.com/icssw-org/MeshCom-Firmware/pull/1151)) transmits AX.25 frames
  from a client, but converts them only into MeshCom text or position messages. They go out under the
  client's own callsign — frames from other callsigns are refused — and at most 8 per second. APRS
  objects are not transmitted.

**Unverified:** whether the T-Deck map shows APRS objects it receives. It is known to show stations'
positions.

## Concept: three layers, one overlay renderer

**1. Text bot — works with today's firmware.** An operator sends `CACHES [grid]` to a bot callsign and
receives the nearest caches in one reply within the message limit. Without a grid, the bot uses the
sender's last beaconed position. It rides the gateway → box transmit channel described in
[Logging finds over radio messages](radio-find-logging.md).

**2. SD-card POI layer — upstream feature.** The firmware loads a GPX or CSV waypoint file from the SD card
and draws it as a map overlay; APRScaching provides a GPX export per region or Maidenhead grid square.

- It works offline and costs no airtime.
- It is generic — repeaters, SOTA summits, shelters — so upstream acceptance is likely.

**3. On-demand APRS objects — upstream feature.** On request, the bot answers with the nearest three to five
caches as APRS objects (object name = cache code, originator = the bot's callsign). This needs two firmware
changes:

- the firmware receives objects and shows them on the map, honouring an expiry time and kill frames;
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
| Does the T-Deck map show received APRS objects? | **Unverified** | Firmware map/display code, then an on-air test |
| Is the message limit counted in bytes or characters? | **Settled: 150 bytes of UTF-8** — the firmware checks `strlen`, so an umlaut costs two bytes (firmware 4.35t, see the [ExtUDP reference](../reference/meshcom-extudp.md)) | — |
| How is the map implemented (tiles, SD storage, renderer, memory headroom for an overlay)? | **Unverified** | Firmware source, T-Deck variant |

## Upstream proposal drafts

Ready to file on [icssw-org/MeshCom-Firmware](https://github.com/icssw-org/MeshCom-Firmware/issues) once the
concept is agreed with ICSSW. **Not filed.**

### Draft: map overlay of waypoints from the SD card

> **Title:** Map: show a waypoint overlay loaded from the SD card (GPX / CSV)
>
> **Problem.** The map shows stations heard on the mesh, but an operator in the field often wants fixed
> points of interest on the same screen — repeaters, SOTA summits, shelters, meeting points, geocaches.
> Today they can only be sent as text, which the map cannot display.
>
> **Proposed behaviour.** At boot (and on a menu action), the firmware reads one waypoint file from the SD
> card, for example `/poi/poi.gpx` or `/poi/poi.csv`, and draws each point as a small symbol with an
> optional short label. A settings switch turns the overlay on or off. Points outside the visible area are
> skipped; nothing is transmitted.
>
> **File format.**
> - *GPX subset:* `<wpt lat="…" lon="…">` with `<name>` (label, truncated to 9 characters) and optional
>   `<sym>` / `<type>`; everything else ignored.
> - *CSV:* `lat,lon,label,symbol` — decimal degrees, label up to 9 characters, symbol an APRS symbol pair
>   (`/;`) or empty for a default. `#` starts a comment line.
>
> **Memory and airtime.** No airtime at all. On the ESP32-S3, points are loaded into a compact array
> (lat/lon as 32-bit integers, 9-byte label, 2-byte symbol ≈ 20 bytes per point), capped at a fixed count
> (for example 500) so the overlay can never exhaust heap; points are filtered per redraw by the visible
> bounding box.
>
> **Why it is generic.** Any group benefits: repeater lists, summit lists for SOTA activators, emergency
> shelters for EmComm exercises, event locations. The file can be produced by any tool that exports GPX.
>
> **Offer.** We can contribute the implementation and test it on a T-Deck Plus (433 MHz).

### Draft: receive and show APRS objects on the map

> **Title:** Map: display received APRS objects with expiry and kill support
>
> **Problem.** APRS objects (`;NAME_____*DDHHMMz…`) are the standard way to announce a point that is not a
> station — an event, a net control position, a temporary repeater. The map shows stations' positions but
> (to our knowledge) not objects, so this information is lost on MeshCom handhelds.
>
> **Proposed behaviour.** When the node receives an APRS object, it stores it keyed by (originator, object
> name) and draws it on the map with its symbol and name. A later object with the same key replaces the
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
> object message. The existing own-callsign check and rate limit stay in force; object frames count
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
- APRS Protocol Reference (APRS101), chapter 11 "Object and Item Reports"
