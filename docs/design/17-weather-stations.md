# Weather stations — ingest a user's PWS into APRS and the platform

Status: **Backlog spec.** APRS treats weather as a first-class function, and the receive side is
already built; this adds the ability for a user to push **their own** personal weather station (PWS)
in — to the platform, to APRS/APRS-IS, and to CWOP. Build against `.claude/rules/{ui-ux,css}.md` and
the cost rules.

## What APRS already specifies (APRS101 weather)
Weather is standard in APRS, in two shapes:
- **Position + weather** (`@`/`!`/`=` with the `_` weather symbol): time + position + weather.
- **Positionless weather** (`_` data-type identifier): time + weather; position carried separately.

Fixed field set: wind dir & sustained speed (`ddd/sss`), gust (`g`), temperature (`t`), rain
last-hour / last-24h / since-midnight (`r`/`p`/`P`), humidity (`h`), barometric pressure (`b`), plus
optional luminosity (`L`/`l`) and snowfall (`s`). The `_` symbol marks a WX station. **CWOP** (Citizen
Weather Observer Program) is the APRS-based PWS network that feeds **NOAA/NWS** — i.e. "PWS → APRS"
is an existing, large ecosystem to plug into, not something to invent.

## What's already built (receive side)
- `@aprsweb/aprs/decode.ts` parses the full weather string (wind dir/speed/gust, temp, rain
  1h/24h/midnight, humidity, pressure) and recognizes both the `_` symbol and positionless weather
  → `DecodedWeather`.
- `sensor_readings` (0001): `station, ts, temp_c, humidity, pressure_hpa, wind_dir, wind_kn, rain_mm`.
- `ingest.ts` routes `kind:"weather"` into `sensor_readings`; `cot.ts` maps `_`/`W` → CoT weather
  type; the station-detail page + Workbench show the reading (smoke-tested).

So any WX station already on RF/APRS-IS appears on our map today. The gap is **origination** — a user
feeding their own station in.

## The four integration shapes (the work)

### W1 — Direct platform ingest (no RF; easiest, highest value)
An authenticated endpoint a PWS pushes to, stored in `sensor_readings` and attributed to the user's
**verified callsign** (the `-13` weather SSID our multi-SSID identity already supports). Speak the
formats consumer stations already emit so most work out of the box:
- **Ecowitt** "customized" HTTP push (Ecowitt/Ambient/many gateways).
- **Weather Underground "Rapidfire"** `GET` protocol (very widely supported).
- (Optional) **WeeWX**/Davis via its uploader.
Endpoint: `POST /api/wx/:station` (or a WU-shaped `GET /api/wx/updateweatherstation`), session- or
key-authenticated, mapped to the user's `-13` station. **No ham licence needed** for this path.

### W2 — APRS WX beacon (TX; the "into APRS" part)
Encode the reading as a standard APRS weather report and beacon it to **RF and/or APRS-IS** via the
existing gated-TX path (the ingest box already does IGate/digi TX). Needs a WX **encoder** (mirror of
the decoder), a **control-verified callsign**, and explicit opt-in — same gating as `docs/design/16` H5
(TX off by default).

### W3 — CWOP relay
Optionally forward a verified user's reading to **CWOP/APRS-IS** (feeding NOAA), and/or consume the
CWOP feed richly. Positions aprscaching as CWOP-friendly rather than a competing weather silo.

### W4 — Browser-direct PWS via Web Serial (ties into `docs/design/16`)
A Davis/Ultimeter/Peet-Bros station on USB-serial decoded **in-browser** → same `sensor_readings`
path, no cloud daemon. Chromium-only, like the rest of the hardware path.

## Schema (small additive migration; next free number)
`sensor_readings` carries the core fields but collapses rain into one `rain_mm` and omits gust /
split rain / luminosity / snow. Extend to the full APRS field set:
```sql
ALTER TABLE sensor_readings ADD COLUMN gust_kn        REAL;
ALTER TABLE sensor_readings ADD COLUMN rain_24h_mm    REAL;
ALTER TABLE sensor_readings ADD COLUMN rain_mid_mm    REAL;   -- since local midnight
ALTER TABLE sensor_readings ADD COLUMN luminosity_wm2 REAL;
ALTER TABLE sensor_readings ADD COLUMN snow_mm        REAL;
ALTER TABLE sensor_readings ADD COLUMN source         TEXT;   -- rf | aprs_is | ecowitt | wu | serial | cwop
```
(`rain_mm` stays = last-hour for back-compat.) The decoder already extracts gust + split rain; W1's
adapters fill the rest.

## Trust / cost / rules
- **Not a find tier.** Weather is observational — it MUST NOT touch the A/B/C find trust tiers.
  Provenance is the **verified callsign** (`-13`); platform-only ingest (W1/W4) carries no RF-licence
  implication, only W2/W3 (TX/CWOP-relay) need the control-verified gate + opt-in.
- **Cost:** beacons/readings are periodic → TTL like other firehose data; W1/W4 run without an
  always-on RF connection; W2 reuses the existing batched TX path.
- **Identity fit:** a user's weather station is just another **station under their base call** (`-13`),
  already anticipated by the `account_callsigns`/stations model (`docs/design/10`).
- **ui-ux/css:** a grouped, toggle-gated **Settings → Home weather station** surface — master switch per
  source (Platform push / APRS beacon / CWOP / Serial), each collapsing its detail when off, with the
  push URL + station key shown for W1; a one-line reason when a path is unavailable (e.g. "verify your
  callsign to beacon"). No inline styles; reduced-motion honored.

## Milestones
- **W1 (platform ingest):** Ecowitt + WU-Rapidfire endpoints → `sensor_readings` on the `-13` station;
  reading shown on the map/station page. (M5 workbench-adjacent.)
- **W2 (APRS beacon):** WX encoder + gated TX to RF/APRS-IS (verified callsign, opt-in).
- **W3 (CWOP):** opt-in relay to CWOP/APRS-IS; richer CWOP consumption.
- **W4 (browser-direct):** Web Serial Davis/Ultimeter/Peet-Bros decode (with `docs/design/16`).

## Acceptance (abbreviated)
- **W1:** an Ecowitt/WU station posting to its endpoint appears as the user's `-13` WX station with
  temp/wind/rain/pressure on the station page; readings persist in `sensor_readings`.
- **W2:** beaconing is impossible until the callsign is control-verified and opted in; the emitted
  frame round-trips through `@aprsweb/aprs` decode back to the same fields.
- **W3:** a verified user's reading reaches CWOP/APRS-IS; nothing is relayed without opt-in.
- **W4:** a Davis/Ultimeter station on Web Serial yields readings in-browser with no cloud feed.
- All paths: weather never alters a find's A/B/C tier; provenance is the verified callsign.
