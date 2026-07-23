# Rig control & weather

## CAT rig control

aprscaching drives a transceiver through one rig-control API with two backends. Frequency and mode changes
are receive-side tuning and are **not** gated; **PTT / keying is gated on a verified callsign**.

### Backend A — browser Web Serial

The pure CAT codec (`@aprscaching/aprs`) speaks three protocol families directly over Web Serial, so a
Chromium browser can tune a radio with no companion software:

- **Kenwood** ASCII (`FA…;`) — Kenwood TS-series, and modern Yaesu (FT-991 / FTDX) which speak Kenwood CAT;
- **Icom CI-V** binary — with the rig's CI-V address;
- **classic Yaesu binary** — FT-817 / 857 / 897.

`catSetFrequency` / `catSetMode` produce the bytes; the browser owns the serial port. One-click tune uses the
APRS calling frequencies (144.800 EU / 144.390 NA).

### Backend B — Hamlib `rigctld` companion

For the 200+ rig long tail, iOS, and headless setups, a **Hamlib `rigctld` companion** covers everything
Hamlib supports. The `RigctldClient` (`@aprscaching/aprs`) speaks the `rigctld` TCP text protocol — set/get
frequency (`F`/`f`), mode (`M`/`m`), PTT (`T`/`t`), and `\dump_state` capability negotiation — over a
transport the companion provides. We shell out to `rigctld` as a **separate process over TCP** and never link
Hamlib, so the library stays MIT-clean.

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
