# Your radio in the browser

You can connect your own radio to aprscaching directly from a web browser — no server, no software to
install. The browser decodes what your radio hears, shows it live, and can pass it on to an instance.

## What you need

- **A Chromium-based browser** — Chrome, Edge, Brave or Opera — on a computer or an Android phone, and the
  site opened over `https://`. Firefox and Safari (and every browser on iPhone/iPad) cannot talk to USB or
  Bluetooth radios; there, use a [ingest box](../operate/rf-ingest.md) instead.
- **One of these:**

| You have | Button | Notes |
|---|---|---|
| A USB KISS TNC, or a radio with a built-in KISS TNC on USB | **Connect USB radio** | Any TNC in KISS mode |
| A Bluetooth Low Energy KISS TNC (e.g. a Mobilinkd) | **Connect Bluetooth** | |
| Just an audio cable from the radio's speaker/data jack to the computer's soundcard | **Soundcard AFSK** | Decodes 1200 baud APRS audio — no TNC needed |
| A Meshtastic node on USB | **Meshtastic node** | Reads node positions; stations appear under their node ID (e.g. `!a1b2c3d4`) |

Only the buttons your browser supports are shown.

## Connect

1. [Sign in](account.md) and open **Settings → My radio (browser)**.
2. Tune your radio to your APRS frequency (144.800 MHz in Europe, 144.390 MHz in North America).
3. Tap the button for your hardware and pick the device in the browser's dialog.
4. The status line turns to **● live (USB radio) · N frames**. Heard packets appear under **Live RX** and in
   the **Field station** panel (**Stations heard**, **Local inbox**) — this works with no internet
   connection at all.

**Disconnect** ends the session. The connection lasts as long as the page is open; for a station that runs
around the clock, use an [ingest box](../operate/rf-ingest.md) on a Raspberry Pi instead.

## Send what you hear to an instance

Turn on **Forward to a gateway** and choose **Auth**:

- **signed (YOURCALL)** — for a public instance such as aprscaching.net. Packets are signed with your
  browser's key; no password is needed. A public instance accepts only **your own station's** packets this
  way (any SSID of your callsign), so a stranger can't inject traffic in your name — which also means other
  stations your radio hears, and Meshtastic nodes, stay in your browser.
- **secret (self-host)** — for your own instance. Open **Self-host gateway**, enter the **Gateway base URL**
  and the instance's **Ingest secret** (the `INGEST_SECRET` its sysop set). The secret stays in this browser.
  With the secret, everything your radio hears is forwarded.

Packets heard through your browser are always **tier C** for find verification: your own radio is not an
independent witness of your own position. They still put stations on the map and messages in the log.

## Transmit (optional)

Receiving is always allowed. Transmitting needs a **verified callsign**
([Your account → Verify](account.md#verify-your-callsign)); until then the **Transmit** section says so.

Once verified, while a radio is connected:

1. Switch on **Enable transmit** — you are the licensed control operator and responsible for what you send.
2. Set the **TX callsign** SSID (default `-7`).
3. **Beacon position** — enter coordinates or tap **Use my location**, add a comment, tap **Beacon**.
   **Message** — enter **to** and **message**, tap **Send**.
4. Every transmission asks you to confirm (**Transmit**) first. Nothing is ever sent automatically.

The soundcard link receives only. Read [Amateur-radio compliance](../operate/rf-regulatory.md) before you
transmit.

## Rig control

**Shack → Rig control** tunes a radio over USB (CAT) from the same browser:

1. Choose the **Radio** family — *Kenwood / modern Yaesu (ASCII)*, *Icom (CI-V)* (set the **CI-V addr**) or
   *Yaesu classic (FT-817/857/897)* — and the **Baud** rate your radio's menu is set to.
2. **Connect rig**, then tap **144.800 (EU APRS)** / **144.390 (NA APRS)**, or type a frequency and **Tune**.

![Rig control after Connect rig](../assets/shots/rig-desktop.webp){ width="720" loading=lazy }

Rig control only sets the frequency; it never keys the transmitter.

## Troubleshooting

| Problem | What to check |
|---|---|
| No connect buttons | Browser is not Chromium-based, or the page is not on `https://`. |
| Connected, but **0 frames** | The TNC is not in KISS mode, the radio is on the wrong frequency, or (soundcard) the input level is too low or too high — aim for the loudest level that doesn't clip. |
| Meshtastic button missing | It needs Web Serial — use desktop Chrome or Edge. |
| Forwarding does nothing | **signed**: you must be signed in. **secret**: the URL or secret is wrong — the sysop can check the gateway log. |
