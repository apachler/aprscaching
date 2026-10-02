# Your radio in the browser

You can connect your own radio to aprscaching directly from a web browser — no server, no software to
install. The browser decodes what your radio hears, shows it live, and can pass it on to an instance.

If you have a radio with a [TNC](../glossary.md#tnc) — a USB or Bluetooth [KISS](../glossary.md#kiss) TNC, a Mobilinkd, or only an audio cable to your
computer's soundcard — you can feed what your radio hears into the platform straight from a Chrome or Edge
browser, with no server. See [Your radio in the browser](my-radio.md).

## What you need

- **A Chromium-based browser** — Chrome, Edge, Brave or Opera — on a computer or an Android phone, and the
  site opened over `https://` (or at `http://localhost`, as on a [Pocket](../run/install/pocket.md) phone). Brave
  ships Web Bluetooth switched off: enable *Web Bluetooth API* in `brave://flags`. Firefox and Safari (and every browser on iPhone/iPad) cannot talk to USB or
  Bluetooth radios; there, use a [ingest box](../run/radios/rf-ingest.md) instead.
- **One of these:**

| You have | Button | Notes |
|---|---|---|
| A USB [KISS](../glossary.md#kiss) [TNC](../glossary.md#tnc), or a radio with a built-in KISS TNC on USB | **Connect USB radio** | Any TNC in KISS mode |
| A Bluetooth Low Energy KISS TNC (e.g. a Mobilinkd) | **Connect Bluetooth** | |
| Only an audio cable from the radio's speaker/data jack to the computer's soundcard | **Soundcard AFSK** | Decodes 1200 baud [APRS](../glossary.md#aprs) audio ([AFSK](../glossary.md#afsk)) — no TNC needed |
| A [Meshtastic](../glossary.md#meshtastic) node on USB | **Meshtastic node** | Reads positions of licensed nodes (licensed/ham mode on, callsign as long name), shown under their callsign; licence-free nodes are ignored |

Only the buttons your browser supports are shown.

## Connect

1. [Sign in](../play/join.md) and open **Settings → My radio (browser)**.
2. Tune your radio to your APRS frequency (144.800 MHz in Europe, 144.390 MHz in North America).
3. Tap the button for your hardware and pick the device in the browser's dialog.
4. The status line turns to **● live (USB radio) · N frames**. Heard packets appear under **Live RX** and in
   the **Field station** panel (**Stations heard**, **Local inbox**) — this works with no internet
   connection at all.

**Disconnect** ends the session. The connection lasts as long as the page is open; for a station that runs
around the clock, use an [ingest box](../run/radios/rf-ingest.md) on a Raspberry Pi instead.

## Send what you hear to an instance

Once a radio is connected (or the field station holds frames heard off-grid), turn on **Forward to a
gateway**; the **Auth** choice appears below it:

- **signed (YOURCALL)** — for a public instance such as aprscaching.net. Packets are signed with your
  browser's key; no password is needed. A public instance accepts only **your own station's** packets this
  way (any [SSID](../glossary.md#ssid) of your callsign), so a stranger can't inject traffic in your name — which also means other
  stations your radio hears, and Meshtastic nodes, stay in your browser.
- **secret (self-host)** — for your own instance. Enter the **Gateway base URL** and the instance's
  **Ingest secret** (the `INGEST_SECRET` its [sysop](../glossary.md#sysop) set). The URL is remembered in this browser; the secret is kept in memory for the session only and is entered again after a reload.
  With the secret, everything your radio hears is forwarded.

Packets heard through your browser never verify a find — at most it is **Logged** (tier C): your own radio
is not an independent witness of your own position, and only the instance's own receiving station can make a
find **Radio-verified**. **What your radio can verify** under the connect buttons says the same. They still put stations on the map and messages in the log.

## Transmit (optional)

Receiving is always allowed. Transmitting needs a **verified callsign**
([Your account → Verify](../play/join.md#verify-your-callsign)); until then the **Transmit** section says so.

Once verified, while a radio is connected:

1. Switch on **Enable transmit** — you are the licensed control operator and responsible for what you send.
2. Set the **TX callsign** SSID (default `-7`).
3. **Beacon position** — enter coordinates or tap **Use my location**, add a comment, tap **Beacon**.
   **Message** — enter **to** and **message**, tap **Send**.
4. Every transmission asks you to confirm (**Transmit**) first. Nothing is ever sent automatically.

The soundcard link receives only. Read [On-air etiquette and rules](on-air.md) before you
transmit.

## Troubleshooting

| Problem | What to check |
|---|---|
| No connect buttons | Browser is not Chromium-based, or the page is not on `https://`. |
| Connected, but **0 frames** | The TNC is not in KISS mode, the radio is on the wrong frequency, or (soundcard) the input level is too low or too high — aim for the loudest level that doesn't clip. |
| Meshtastic button missing | It needs Web Serial — use desktop Chrome or Edge. |
| Forwarding does nothing | **signed**: you must be signed in. **secret**: the URL or secret is wrong — the sysop can check the gateway log. |

## Next

- [The live map](live-map.md).
- [Rig control & weather](rig-weather.md).
