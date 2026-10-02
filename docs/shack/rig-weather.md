# Rig control & weather

Tune your transceiver from the browser, and send your weather station's readings to the instance.

## CAT rig control

The **Shack → Rig control** app tunes a transceiver from the browser (step by step:
[Rig control](#step-by-step)). Frequency and mode changes are receive-side tuning and are
**not** gated; **PTT / keying is gated on a verified callsign**.

### In the browser (Web Serial)

The pure CAT codec (`@aprscaching/aprs`) speaks three protocol families directly over Web Serial, so a
Chromium browser can tune a radio with no companion software:

- **Kenwood** ASCII (`FA…;`) — Kenwood TS-series, and modern Yaesu (FT-991 / FTDX) which speak Kenwood CAT;
- **Icom CI-V** binary — with the rig's CI-V address;
- **classic Yaesu binary** — FT-817 / 857 / 897.

`catSetFrequency` / `catSetMode` produce the bytes; the browser owns the serial port. One-click tune uses the
APRS calling frequencies (144.800 EU / 144.390 NA).

### Step by step

**Shack → Rig control** tunes a radio over USB ([CAT](../glossary.md#cat)) from the same browser:

1. Choose the **Radio** family — *Kenwood / modern Yaesu (ASCII)*, *Icom ([CI-V](../glossary.md#ci-v))* (set the **CI-V addr**) or
   *Yaesu classic (FT-817/857/897)* — and the **Baud** rate your radio's menu is set to.
2. **Connect rig**, then tap **144.800 (EU APRS)** / **144.390 (NA APRS)**, or type a frequency and **Tune**.

![Rig control after Connect rig](../assets/shots/rig-desktop.webp){ width="720" loading=lazy }

Rig control only sets the frequency; it never keys the transmitter.

## Weather stations

APRS weather is first-class: the decoder parses weather beacons into `sensor_readings` and the station page
graphs them. Operators can also originate their **own** personal weather station (PWS) through the platform:

- **Direct push.** Point an Ecowitt or Weather Underground (Rapidfire) station at the gateway
  (`POST /api/wx/submit` / `/api/wx/updateweatherstation`) authenticated by a per-station **weather key**.
  Manage the key and station under *Settings → My stations* (`GET/POST /api/wx/key`, `/api/my/stations/:sid/wx-key`).
  A weather station lives under the operator's `-13` weather SSID and needs no licence to push data in.
- **APRS WX beacon (TX).** Toggle a station to beacon its readings out to APRS-IS (`POST /api/wx/tx`) — this
  is a gated, opt-in transmit path that requires a verified callsign.
- **CWOP relay.** Weather items can be routed to a CWOP server (`CWOP_HOST` / `CWOP_PORT`), feeding NOAA's
  Citizen Weather Observer Program.

Weather is observational: it enriches station pages and the map but never affects the A/B/C find tiers.

## Next

- [On-air etiquette and rules](on-air.md).
