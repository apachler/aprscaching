# Automatic beacons

This page sets your ingest box to send its own position on the air by itself: at a fixed interval, or with
SmartBeaconing from a GPS when the box moves. It is for the sysop who runs the box; at the end the box beacons
under its station call and the instance's map shows it.

Beacons are off by default. They go out only on a port that transmits, and only through every gate any frame of
the box passes.

## Before you start

- A running ingest box with a port that transmits: a KISS TNC, or a [soundcard port](soundcard.md) with
  `SOUNDCARD_TX=1` ([Set up an ingest box](ingest-box.md)).
- A station call on the box, `BOX_CALL` (else `IGATE_CALL`, else `DIGI_CALL`), whose base call is a
  [verified callsign](../day-to-day/callsign-verification.md) of the box's operator. The gateway confirms the call
  for this box before the box keys its radio, as for every other transmission.
- For a moving box, a position source: an Android phone in Termux ([Pocket](../install/pocket.md)), gpsd, or a
  serial GPS receiver.

## Set it up

### 1. Choose the mode

```bash
BEACON=fixed      # every BEACON_INTERVAL_MIN minutes (default 20, at least 10)
# or
BEACON=smart      # SmartBeaconing: the interval follows the speed, and a turn beacons at once
```

### 2. Choose where the position comes from

| `BEACON_POSITION` | Position | Default symbol |
|---|---|---|
| `fixed` (default) | `BOX_LAT` and `BOX_LON`, in degrees | `/-` house |
| `termux` | the phone's GPS, through Termux:API | `/[` person |
| `gpsd` | a gpsd daemon, `BEACON_GPSD` (default `127.0.0.1:2947`) | `/>` car |
| `nmea` | a serial GPS receiver, `BEACON_NMEA_DEVICE` at `BEACON_NMEA_BAUD` (default 9600) | `/>` car |

`BEACON_SYMBOL` sets another symbol, table then code, for example `/k` for a truck.

### 3. Set the comment and the path

```bash
BEACON_COMMENT=APRScaching field station
BEACON_COMMENT_EVERY=3     # on VHF, the comment rides on one beacon in three (default: every beacon)
BOX_TX_PATH=WIDE1-1        # default WIDE1-1,WIDE2-1; blank sends direct
```

The comment holds 43 bytes. Restart the ingest. Its log says, for each port, how it beacons:
`[beacon] SmartBeaconing beacons as OE8APR-9 on kiss from the termux position`.

## Position sources

### A Pocket phone (Termux:API)

The phone's own GPS places the box. Install the **Termux:API** app from the same source as Termux, open it once,
and allow it the location permission. Then, in Termux:

```bash
pkg install termux-api
termux-location -p gps -r once     # prints one fix as JSON: the permission works
```

Set `BEACON_POSITION=termux`. The box runs `termux-location -p gps -r updates` and reads each fix it prints.
Android can stop the fixes of an app it puts to sleep: exempt Termux and Termux:API from battery optimisation.

### gpsd

gpsd shares one GPS receiver between programs. Install it, point it at the receiver, and set
`BEACON_POSITION=gpsd`. The box connects to `BEACON_GPSD`, asks for JSON reports, and reads the position,
speed, course and altitude of each fix.

### A serial GPS receiver (NMEA)

A USB GPS (`/dev/ttyACM0`) or one on a Raspberry Pi's serial pins (`/dev/serial0`) that sends NMEA 0183:

```bash
BEACON_POSITION=nmea
BEACON_NMEA_DEVICE=/dev/ttyACM0
BEACON_NMEA_BAUD=9600
```

The box reads RMC sentences for the position, speed and course, and GGA for the altitude. It needs the optional
`serialport` package, as a serial PTT does ([Soundcard port](soundcard.md)). A port that gpsd already holds
cannot be read twice: use `gpsd` then.

## What the box sends

| | VHF, fixed position | VHF, moving source | HF port |
|---|---|---|---|
| Format | position with comment | Mic-E with speed, course and altitude | Mic-E |
| Path | `BOX_TX_PATH` | `BOX_TX_PATH` | none |
| Comment | one beacon in `BEACON_COMMENT_EVERY` | one beacon in `BEACON_COMMENT_EVERY` | one beacon in four |
| Interval | `BEACON_INTERVAL_MIN` | `BEACON_INTERVAL_MIN`, or SmartBeaconing | at least 10 min, whatever the mode |

A moving box sends Mic-E: nine bytes carry the position, speed and course, against nineteen for a plain position
without them, and every APRS radio decodes it. A fix older than 2 minutes is not beaconed, so a box that lost its
GPS never reports where it was.

### SmartBeaconing

SmartBeaconing (Tony Arnerich KD7TA and Steve Bragg KA9MVA, for the HamHUD) beacons often when the station moves
fast and seldom when it stands, and at once on a turn:

| Setting | Value |
|---|---|
| Below 5 km/h | every `BEACON_SLOW_MIN` minutes (default 30, 1 to 60) |
| From 90 km/h | every `BEACON_FAST_SEC` seconds (default 90, 30 to 600) |
| Between | the fast rate × 90 km/h ÷ speed: 3 min at 45 km/h, never slower than the slow rate |
| A turn sharper than 28° plus 255 degree·mph ÷ speed | a beacon at once, at most every 30 s |

On an HF port the 10-minute floor holds whatever the rates say.

### Gates

A beacon goes out only when all of these hold:

- the port is the KISS TNC's transmit channel (`KISS_TNC_TX_CHANNEL`) or a soundcard port allowed to transmit;
- the gateway confirmed the station call for this box ([Callsign verification](../day-to-day/callsign-verification.md));
- transmit is switched on (**TX off** in [Remote control of your box](remote-box.md) silences beacons too);
- the beacon pacing allows it: `BEACON_TX_BURST` (default 2) at once, then one per `BEACON_TX_REFILL_SEC`
  (default 60) ([transmit pacing](../compliance/on-air-stations.md#transmit-pacing)).

A beacon held back waits for the next look, five seconds later; the log says why at most every 10 minutes.

## Trust

The box's own beacons are its operator's travels, heard like any station's. Its own receiver drops the echo of
what it sent. A copy a digipeater repeats back is a hearing of the station, but the logger's own box is never
independent of the logger, so it never makes the operator's own find [Tier A](../../glossary.md#tier).

## A living cache on the move

A [living cache](../../play/cache-types/living.md) follows a station's beacons. A Pocket phone with
`BEACON=smart` and `BEACON_POSITION=termux` makes a good one: it beacons every 90 s at speed and on every turn,
so a player who meets it has a station position close in time.

A find needs the station's position within 5 minutes of the player's, so a station that is a living cache sets
the slow rate to 4 minutes or less:

```bash
BEACON=smart
BEACON_POSITION=termux
BEACON_SLOW_MIN=4
```

With the default 30 minutes, a player who meets the station while it is parked may find no position close
enough. On HF the 10-minute floor still holds, so a living cache beacons on VHF.

## Validate at deploy

- **Unverified:** Termux:API fixes with the screen off on your phone model.
- **Unverified:** your GPS receiver's baud rate and sentences.

## Next

- [Remote control of your box](remote-box.md): send a beacon by hand, or switch transmit off.
- [HF APRS on 30 m](hf.md): the HF preset.
