# Connect a radio: quick starts

This page takes one radio link at a time from nothing to packets on the map. It is for the sysop of an
instance; each section ends with the log line that shows the link works.

## Before you start

- **An ingest box.** The Self-host stack runs one already; a separate box next to the radio is set up in
  [Set up an ingest box](ingest-box.md).
- **Where the settings go.** In the Docker stack, `deploy/.env`; from a checkout, `.env` at the top of the
  repository. After each change, restart the ingest. In `deploy/`:

    ```bash
    docker compose up -d                                  # the Self-host stack
    docker compose -f compose.ingest-only.yml up -d       # an ingest box on its own
    ```

- **Where the log is.** In `deploy/`, `docker compose logs -f ingest` (add `-f compose.ingest-only.yml` on an
  ingest box on its own). Each section below names the line to look for.
- **Inside a container, `localhost` is the container.** Point a setting at the host's LAN address, for
  example `KISS_TNC_HOST=192.168.1.20`. Links that receive UDP need a published port:
  [From a container](rf-ingest.md#from-a-container).

Every link also counts its packets: `https://<instance>/api/ports` lists packets per port over the last 24
hours, and the map shows the stations under **Search & filter → Live layers → Live stations**. Every
setting is in [RF ingest & transports](rf-ingest.md). To connect a radio from a browser instead, see
[Your radio in the browser](../../shack/my-radio.md).

## APRS-IS (internet feed)

Receive APRS traffic for your area from the internet, with no radio. Everything from APRS-IS is Tier C.

1. Set your callsign and an area filter:

    ```
    APRSIS_CALLSIGN=OE8APR
    APRSIS_PASSCODE=-1
    APRSIS_FILTER=r/47.07/15.42/200
    ```

    `-1` is a receive-only login, which is all the feed needs. `r/lat/lon/km` is a circle around a point;
    any [APRS-IS server filter](https://www.aprs-is.net/javAPRSFilter.aspx) works (`b/`, `p/`, `t/`, …).

2. Restart the ingest. The log shows `[aprs-is] connected + filter sent`.
3. The `aprs-is` port counts packets, and stations appear on the map.

## KISS TNC with Direwolf (soundcard or hardware TNC)

[Direwolf](https://github.com/wb2osz/direwolf) turns a soundcard and a radio into a TNC and offers it as
KISS over TCP. A hardware TNC with a KISS-over-TCP server works the same way.

1. Write a minimal `direwolf.conf` (1200 baud APRS):

    ```
    ADEVICE plughw:1,0
    CHANNEL 0
    MYCALL OE8APR-10
    MODEM 1200
    PTT CM108
    KISSPORT 8001
    AGWPORT 8000
    ```

    `ADEVICE` is your USB soundcard (list them with `arecord -l`). `PTT` is needed only to transmit; with a
    serial interface it looks like `PTT /dev/ttyUSB0 RTS`.

2. Start Direwolf and check in its own window that it decodes packets.
3. Point the ingest at it:

    ```
    KISS_TNC_HOST=127.0.0.1
    KISS_TNC_PORT=8001
    ```

4. Restart the ingest. The log shows `[kiss] connected 127.0.0.1:8001`.
5. The `kiss-tnc` port counts packets.

Without Direwolf, the box can be the modem itself: [Soundcard port (no TNC)](#soundcard-port-no-tnc).

**Count it for find verification (optional).** For a TNC you operate, add `RF_SITE_CALL=OE8APR-10`. The log
then shows `[kiss] enabled — direct hearings name site OE8APR-10`. What the receiving site does, and the
gateway setting that attests it, are in [Receiving site and Tier A](rf-ingest.md#receiving-site-and-tier-a).

Receiving never transmits. The ingest transmits over KISS only when you turn on a digipeater, an IGate, the
node or BBS forwarding.

## Soundcard port (no TNC)

The ingest box can be the modem itself: a USB sound card or a sound HAT between the box and the radio, with no
Direwolf and no TNC. It needs ALSA's `arecord` and `aplay` (the Docker image has them).

1. Find the card with `arecord -l`: `card 1: … device 0` is `plughw:1,0`.
2. Set it:

    ```
    SOUNDCARD_DEVICE=plughw:1,0
    ```

3. In Docker, pass the sound devices (and the PTT device, to transmit) into the ingest container
   ([Turn the port on](soundcard.md#2-turn-the-port-on)), then restart the ingest.

The log shows `[soundcard:1] capturing plughw:1,0 at 48000 Hz`; packets count on the `soundcard` port.
Receiving never transmits. To transmit, choose how the radio is keyed (CM108 GPIO, Linux GPIO, serial RTS or
DTR, CAT, `rigctld` or VOX) and set `SOUNDCARD_TX=1` and `SOUNDCARD_PTT`: [Soundcard port](soundcard.md).
`RF_SITE_CALL` works here as for KISS.

## AGWPE: Direwolf, SoundModem, UZ7HO

Programs that offer the AGW Packet Engine interface (port 8000) can feed the ingest instead of KISS:

```
AGWPE_HOST=127.0.0.1
AGWPE_PORT=8000
AGWPE_RADIO_PORT=0
```

The log shows `[agwpe] connected 127.0.0.1:8000`; packets count on the `agwpe` port. This link only
receives. `RF_SITE_CALL` works here as for KISS.

## WA8DED hostmode (TheFirmware TNCs, TFPCX)

```
HOSTMODE_HOST=127.0.0.1
HOSTMODE_PORT=3694
HOSTMODE_MYCALL=OE8APR
```

`HOSTMODE_MYCALL` is the callsign the TNC is set to. The log shows `[hostmode] connected 127.0.0.1:3694`;
packets count on the `hostmode` port. This link only receives. `RF_SITE_CALL` works here as for KISS.

## Your own IGate

An IGate passes what your radio hears to APRS-IS and, when you allow it to transmit, APRS-IS messages for
nearby stations back to RF. It needs a working [KISS TNC](#kiss-tnc-with-direwolf-soundcard-or-hardware-tnc) or
[soundcard port](#soundcard-port-no-tnc); passing messages to RF also needs PTT and `IGATE_TX=1`. An IGate is an automatically controlled station: read
[Automatic stations on the air](../compliance/on-air-stations.md) first.

1. Add the IGate's callsign and its APRS-IS passcode:

    ```
    IGATE_CALL=OE8APR-10
    IGATE_PASS=12345
    ```

2. To pass messages to RF as well, add `IGATE_TX=1`. Leave it out for a receive-only IGate.

3. Restart the ingest. The log shows `[igate] enabled as OE8APR-10`, then `[igate] APRS-IS connected`. A
   message it sends to RF logs `[igate] TX->RF message for …`.

Without `RF_SITE_CALL`, the ingest names `IGATE_CALL` as the receiving site of what the TNC hears directly.
The copies the IGate passes to APRS-IS never count for Tier A:
[Receiving site and Tier A](rf-ingest.md#receiving-site-and-tier-a) says why. Which messages go to RF is in
[IGate](rf-ingest.md#igate).

## Digipeater

A digipeater is an automatically controlled station: read
[Automatic stations on the air](../compliance/on-air-stations.md) before you turn it on. It needs a KISS TNC
with PTT, or a soundcard port with its PTT and `SOUNDCARD_TX=1`.

```
DIGI_CALL=OE8APR-10
DIGI_ALIASES=WIDE1,WIDE2
```

The log shows `[digi] enabled as OE8APR-10 (WIDE1,WIDE2)`, and `[digi] repeated …` for each repeat. Options
are in [Digipeater](rf-ingest.md#digipeater).

## Meshtastic

Only **licensed** Meshtastic nodes appear. A node must run Meshtastic's licensed (ham) mode, which sets its
licence flag and makes its long name your callsign (for example `OE8APR-7`). Positions show under that
callsign. Licence-free nodes are ignored: they have no callsign to show. Turn on licensed mode in the
Meshtastic app (**Settings → User → Licensed amateur radio**, callsign as the long name). It switches off
channel encryption, as amateur rules require.

The ingest reads the node's protobuf stream in one of two ways, or both:

=== "Node on your network (TCP)"

    A Meshtastic node on Wi-Fi or Ethernet serves its data on TCP port 4403.

    ```
    MESHTASTIC_HOST=192.168.1.60
    ```

    The log shows `[meshtastic] connected 192.168.1.60:4403`.

=== "MQTT broker"

    Nodes with the **MQTT** module send their traffic to a broker. The ingest subscribes to the protobuf
    topics:

    ```
    MESHTASTIC_MQTT_URL=mqtt://user:password@broker.example.net
    # MESHTASTIC_MQTT_TOPIC=msh/#
    ```

    The log shows `[meshtastic-mqtt] connected, subscribed to msh/#`. Use `mqtts://` for a TLS broker.

A licensed node's positions appear once its node info has been heard; a node announces it every ten minutes.
Until then the ingest logs once that it drops positions from nodes not known to be licensed. Positions count
on the `meshtastic` port and are always Tier C. A Meshtastic node on USB can also be read from the browser:
[Your radio in the browser](../../shack/my-radio.md).

## MeshCom

MeshCom has its own guide: [MeshCom](meshcom.md). In short: `--extudpip <ingest box IP>` and `--extudp on`
on the node, `MESHCOM_NODE=<node IP>=<node call>` on the ingest.

## AXUDP and AXIP (packet over the internet)

Link the ingest with other packet nodes (LinBPQ, JNOS, …) over the internet or HAMNET.

```
AXUDP_PORT=10093
AXUDP_PEERS=bpq.example.net:10093
```

The log shows `[axudp] port udp/10093 ↔ bpq.example.net:10093 (Tier C)`. The port then accepts frames only
from the peers' addresses and drops the rest. Without `AXUDP_PEERS` it only listens, from any host, and warns
about that at start; bind it to your LAN with `AXUDP_BIND`. The node, the BBS and FBB forwarding run over
this link even without a radio: [Packet: BBS & NET/ROM node](packet-node.md).

AXIP (raw IP protocol 93) is the same with `AXIP_PEERS=host1,host2` (no ports). It needs the optional
`raw-socket` package and the `CAP_NET_RAW` privilege; without them the log shows `[axip] disabled — …`.
Between two 44Net addresses, see [AXUDP and AXIP peering over 44Net](../networks/44net.md#axudp-and-axip-peering-over-44net).

Everything that arrives over the internet is Tier C.

## Next

- [RF ingest & transports](rf-ingest.md): every transport setting, and how a receiving site reaches Tier A.
- [MeshCom](meshcom.md): a MeshCom node on your LAN.
