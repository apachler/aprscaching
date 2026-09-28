# Connect a radio: quick starts

Each section below takes one kind of radio link from zero to "packets on the map" in a few steps. For the
full list of settings see [RF ingest & transports](rf-ingest.md); for connecting a radio from a browser
without any of this, see [Your radio in the browser](../guides/my-radio.md).

## Before you start: the ingest box

Radio traffic reaches an instance through the **ingest box** — a small program on a Raspberry Pi or PC next
to your radio. It sends what it hears to the instance's gateway, which can be on the same machine, on your
LAN, or in the cloud.

- **Docker** (the usual way): the full stack already contains the ingest box. To run only the ingest box and
  feed a remote instance, use `deploy/compose.ingest-only.yml`. Settings go in `deploy/.env`; apply them with
  `docker compose up -d`. See [Running in Docker](docker.md).
- **From a checkout**: settings go in `.env` at the top of the repository (copy `.env.example`); start it
  with `pnpm --filter @aprscaching/ingest start`.

Two settings are always needed:

```
INGEST_URL=http://127.0.0.1:8787/ingest
INGEST_SECRET=…
```

`INGEST_URL` is the gateway's `/ingest` address; `INGEST_SECRET` must be the same secret the gateway has.

**How you know it works.** The box logs a line per link (shown in each section below). It is silent while
forwarding succeeds and logs `[forward] gateway unreachable …` when it can't reach the gateway. On the
instance, `https://<instance>/api/ports` counts received packets per link over the last 24 hours, and the map
shows the stations under **Search & filter → Live layers → Live stations**.

!!! note "Docker and your radio"
    Inside a container, `localhost` is the container itself. Point the settings at your host's LAN address
    (e.g. `KISS_TNC_HOST=192.168.1.20`), and publish UDP ports for links that receive UDP (MeshCom and
    AXUDP) — see [Running in Docker](docker.md#rf-hardware-from-a-container).

## APRS-IS (internet feed)

Receive APRS traffic from the internet for your area — no radio needed. Everything from APRS-IS is tier C.

1. Set your callsign and an area filter:

    ```
    APRSIS_CALLSIGN=OE8APR
    APRSIS_PASSCODE=-1
    APRSIS_FILTER=r/47.07/15.42/200
    ```

    `-1` is a receive-only login, which is all the feed needs. `r/lat/lon/km` is a circle around a point;
    any [APRS-IS server filter](https://www.aprs-is.net/javAPRSFilter.aspx) works (`b/`, `p/`, `t/`, …).
2. Start the box. It logs `[aprs-is] connected + filter sent`.
3. Check: the `aprs-is` port counts packets, and stations appear on the map.

## KISS TNC with Direwolf (soundcard or hardware TNC)

[Direwolf](https://github.com/wb2osz/direwolf) turns a soundcard and a radio into a TNC and offers it as
KISS over TCP. A hardware TNC with a KISS-over-TCP server works the same way.

1. Minimal `direwolf.conf` (1200 baud APRS):

    ```
    ADEVICE plughw:1,0
    CHANNEL 0
    MYCALL OE8APR-10
    MODEM 1200
    PTT CM108
    KISSPORT 8001
    AGWPORT 8000
    ```

    `ADEVICE` is your USB soundcard (list them with `arecord -l`). `PTT` is only needed to transmit; with a
    serial interface it looks like `PTT /dev/ttyUSB0 RTS`.

2. Start Direwolf and check it decodes packets in its own window first.
3. Point the box at it:

    ```
    KISS_TNC_HOST=127.0.0.1
    KISS_TNC_PORT=8001
    ```

4. Start the box. It logs `[kiss] connected 127.0.0.1:8001`.
5. Check: the `kiss-tnc` port counts packets.
6. **Make it count for find verification** (optional): set `RF_SITE_CALL=OE8APR-10` on the box — the
   callsign that names this receiver — and add the same call to `FIRST_PARTY_SITES` on the gateway. Frames
   your radio hears **directly** (not through a digipeater) then count as radio-verified evidence
   (**tier A**) for other people's finds, even with no internet. Your own finds never do: your own receiver
   is not an independent witness. With an IGate configured, `IGATE_CALL` is used when `RF_SITE_CALL` is
   not set. The same works for an AGWPE or host-mode TNC. Set it only for a TNC you operate — not when
   `KISS_TNC_HOST` points at someone else's station.

Receiving alone never transmits. The box transmits over KISS only when you enable a digipeater, IGate,
node or BBS forwarding below.

## AGWPE: Direwolf, SoundModem, UZ7HO

Programs that offer the AGW Packet Engine interface (port 8000) can feed the box instead of KISS:

```
AGWPE_HOST=127.0.0.1
AGWPE_PORT=8000
AGWPE_RADIO_PORT=0
```

It logs `[agwpe] connected 127.0.0.1:8000`; packets count on the `agwpe` port. This link only receives.

## WA8DED hostmode (TheFirmware TNCs, TFPCX)

```
HOSTMODE_HOST=127.0.0.1
HOSTMODE_PORT=3694
HOSTMODE_MYCALL=OE8APR
```

It logs `[hostmode] connected …`; packets count on the `hostmode` port. This link only receives.

## Your own IGate

An IGate passes what your radio hears to APRS-IS, and APRS-IS messages for nearby stations back to RF. It
needs a working [KISS TNC](#kiss-tnc-with-direwolf-soundcard-or-hardware-tnc); passing messages to RF
also needs PTT.

1. Add your IGate callsign and its APRS-IS passcode:

    ```
    IGATE_CALL=OE8APR-10
    IGATE_PASS=12345
    ```

2. Start the box: `[igate] enabled as OE8APR-10`, then `[igate] APRS-IS connected`. Messages it sends to RF
   log `[igate] TX->RF message for …`.
3. **Make it count for find verification**: on the gateway, set `FIRST_PARTY_SITES=OE8APR-10`. The box
   names `IGATE_CALL` as the receiving site of every frame it hears directly, so those frames can reach
   **tier A** right away — except for your own finds, because your own receiver is not an independent
   witness. Frames the IGate passes to APRS-IS (tagged `qAR,OE8APR-10`) are attested the same way when they
   come back through the box's [APRS-IS feed](#aprs-is-internet-feed).

The IGate only sends messages to RF for stations heard locally in the last 30 minutes
(`IGATE_LOCAL_TTL`) and honours `NOGATE`/`RFONLY`. Read [Amateur-radio compliance](rf-regulatory.md) first:
an IGate is an automatically controlled station.

## Digipeater

```
DIGI_CALL=OE8APR-10
DIGI_ALIASES=WIDE1,WIDE2
```

The box logs `[digi] enabled as OE8APR-10 …` and `[digi] repeated …` for each repeat. `DIGI_VISCOUS_MS=3000`
waits and skips a repeat when a better-placed digipeater was heard doing it first. Needs a KISS TNC with PTT.

## Meshtastic

The box reads Meshtastic positions as JSON from a TCP port. Meshtastic nodes publish JSON through their
**MQTT** module, so you need an MQTT broker and a small bridge.

1. On an ESP32-based node (nRF52 nodes cannot publish JSON): enable the **MQTT** module, set your broker,
   and turn on **JSON output**.
2. Serve the JSON stream on a TCP port with `socat` and `mosquitto_sub` (packages `socat` and
   `mosquitto-clients`):

    ```bash
    socat TCP-LISTEN:1884,reuseaddr,fork \
      EXEC:"mosquitto_sub -h <broker> -t 'msh/+/2/json/#' -F '%p'"
    ```

3. Point the box at it:

    ```
    MESH_HOST=127.0.0.1
    MESH_PORT=1884
    ```

4. It logs `[mesh] connected 127.0.0.1:1884`; positions count on the `meshtastic` port and appear as
   `MSH…` stations. Meshtastic is licence-free ISM radio, so these stations are always tier C.

A Meshtastic node on USB can also be read straight from the browser: [Your radio in the
browser](../guides/my-radio.md).

## MeshCom

MeshCom has its own guide: [MeshCom](meshcom.md). In short: `--extudpip <box IP>` and `--extudp on` on the
node, `MESHCOM_NODE=<node IP>=<node call>` on the box.

## AXUDP and AXIP (packet over the internet)

Link the box with other packet nodes (LinBPQ, JNOS, …) over the internet or HAMNET.

```
AXUDP_PORT=10093
AXUDP_PEERS=bpq.example.net:10093
```

It logs `[axudp] port udp/10093 ↔ bpq.example.net:10093`. The box then accepts frames only from the peers'
addresses and drops the rest. Without `AXUDP_PEERS` it only listens, from any host — it warns about that at
startup; bind it to your LAN with `AXUDP_BIND`. The node, BBS and FBB forwarding run over this link even
without a radio — see [Packet BBS & node](packet.md).

AXIP (raw IP protocol 93) is the same with `AXIP_PEERS=host1,host2` (no ports). It needs the optional
`raw-socket` package and the `CAP_NET_RAW` privilege; without them it logs `[axip] disabled — …`.

Everything that arrives over the internet is tier C.
