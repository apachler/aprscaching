# Your radio in the browser

This page shows you how to connect your own radio to APRScaching from a web browser, with no server and no
software to install. You need a radio with a TNC, or only an audio cable; at the end the browser decodes what
your radio hears, shows it live, and can pass it on to an instance.

## What you need

- **A Chromium-based browser**: Chrome, Edge, Brave or Opera, on a computer or an Android phone. Open the site
  over `https://`, or at `http://localhost` as on a [Pocket](../run/install/pocket.md) phone. Brave ships Web
  Bluetooth switched off: enable *Web Bluetooth API* in `brave://flags`.
- **A signed-in account** ([Join](../play/join.md)).
- **One of these:**

| You have | Button | Notes |
|---|---|---|
| A USB [KISS](../glossary.md#kiss) [TNC](../glossary.md#tnc), or a radio with a built-in KISS TNC on USB | **Connect USB radio** | Any TNC in KISS mode |
| A Bluetooth Low Energy KISS TNC, such as a Mobilinkd TNC3 or TNC4 | **Connect Bluetooth** | Finds TNCs that offer the BLE KISS service (Mobilinkd, many LoRa APRS trackers) or the Nordic UART service |
| Only an audio cable from the radio's speaker or data jack to the computer's soundcard | **Soundcard AFSK** | Direwolf's software modem, running in the browser: decodes 1200-baud packet audio ([AFSK](../glossary.md#afsk), Bell 202), the modem [APRS](../glossary.md#aprs) uses on 144.800 and 144.390 MHz, so no TNC is needed. Receive only. **Soundcard HF**, under **Other APRS channels**, decodes 300-baud HF APRS from an SSB radio on 10.1476 MHz USB. See [The soundcard modem](#the-soundcard-modem) |
| A [Meshtastic](../glossary.md#meshtastic) node on USB | **Meshtastic node** | Reads positions of licensed nodes (licensed mode on, callsign as long name) and shows them under their callsign; licence-free nodes are ignored. Receive only |

The page shows only the buttons your browser supports, and a line under them names the links it lacks. USB
radios and Meshtastic nodes need Web Serial; Bluetooth TNCs need Web Bluetooth. Only Chromium-based browsers
have them, so Firefox and Safari, and every browser on an iPhone or iPad, show **Soundcard AFSK** alone. For
those, an [ingest box](../run/radios/ingest-box.md) feeds the instance instead.

## Connect

1. Open **Settings → My radio (browser)**.
2. Tune your radio to your APRS frequency. The line under the buttons names it, as in
   **APRS in Austria: 144.800 MHz**: the country comes from your callsign's prefix, or from your browser's
   language region when the prefix names no country the app knows. **Other APRS channels** lists LoRa APRS
   (433.775 MHz) and the ISS digipeater (145.825 MHz). The app never changes your radio's frequency.
3. Select the button for your hardware and pick the device in the browser's dialog.
4. The status line shows **● live (USB radio) · N frames**. Heard packets appear under **Live RX**.

The radio stays connected while you use the rest of the app: close Settings, open the map or **Messages**, and
it keeps listening. While it is connected, a radio chip in the top bar shows the radio, the number of frames
heard and the transmit state (**TX on**, **RX only** or **TX locked** until your callsign is verified). Select
the chip to come back here; while your radio waits for [transmit consent](#allow-transmitting-for-this-tab),
selecting it asks for it instead.

The link ends when you select **Disconnect**, sign out, or close or reload the page. When the device goes away
(unplugged, out of Bluetooth range), the app says **Radio disconnected** and why. For a station that runs around
the clock, the instance's sysop runs an [ingest box](../run/radios/ingest-box.md) instead.

## Work off-grid

Your radio and the browser are a station on their own. With no internet at all, the **Field station** panel
lists **Stations heard** in the last hour and a **Local inbox** of the messages your radio heard. The panel
keeps up to 500 heard frames for later.

Back online, turn on forwarding (next section) and select **Sync N heard** to replay those frames to the
instance. Your own beacons stay out of the replay.

## Send what you hear to an instance

1. With a radio connected, or with frames held by the field station, switch on **Forward to a gateway**.
2. Choose the **Auth**:
    - **Signed (YOURCALL)**: for a public instance such as aprscaching.net. Your browser's key signs each
      batch, so no password is needed. The instance accepts only your own station's packets this way (any
      [SSID](../glossary.md#ssid) of your callsign). Other stations your radio hears, and Meshtastic nodes, stay in
      your browser. That way no stranger can inject traffic in your name.
    - **Secret (self-host)**: for your own instance. Enter the **Gateway base URL** and the **Ingest secret**
      that the instance's [sysop](../glossary.md#sysop) set. With the secret, everything your radio hears is
      forwarded. The browser remembers the URL; it keeps the secret in memory for this session only, so you
      enter it again after a reload.

Packets your browser forwards never verify a find: at most a find is **Logged** (Tier C). Your own radio is
not an independent witness of your own position: only a receiving station the instance trusts, hearing the
frame on its own radio, can make a find **Radio-verified**. **What your radio can verify**, under the connect buttons, says the same. The
packets still put stations on the map and messages in the log.

## Transmit

Receiving is always allowed. Transmitting needs a [verified callsign](../play/join.md#verify-your-callsign),
a USB or Bluetooth TNC, and your consent for this tab; until your callsign is verified, the **Transmit**
section says so.

### Allow transmitting for this tab

When a USB or Bluetooth TNC connects under a verified callsign, the app asks once:
**Allow transmitting from YOURCALL-7 over your USB radio until you close this tab?**

- **Allow** lets this tab transmit from that callsign over that radio.
- **Receive only** keeps the radio listening and sends nothing. Switch on **Transmit in this tab**, or select
  the radio chip in the top bar, to be asked again.

The consent lasts until you close the tab, and ends sooner when you switch **Transmit in this tab** off,
disconnect the radio, lose the device, change the SSID, sign out or lose your callsign's verification. The
app keeps it in the tab's memory only, so a reload or a new tab asks again. Nothing your radio sends goes out
without it. Messages the instance sends for you (to APRS-IS, from the Mailbox, announcements) do not use your
radio and follow their own settings.

### Send a beacon

1. Check the **TX callsign**: your callsign with the SSID you type, `-7` by default.
2. Under **Beacon position**, enter the latitude and longitude or select **Use my location**, and add an
   optional comment.
3. Select **Beacon**, then **Transmit** in the confirmation.

A beacon and a message from this section ask you to confirm first. A message sent from **Messages** over the
radio, and the **ACK** you send for a message heard for you, go out without a dialog: the tab's transmit consent
covers them. Every one shows in the TX indicator and under **Recent transmissions**. To send a text message, see
[Send an APRS message](messages.md#send-an-aprs-message-from-your-radio). Read
[On-air etiquette and rules](on-air.md) before you transmit.

### See what you transmitted

For every frame your browser sends, the radio chip in the top bar lights **TX**, and a screen reader hears
**Transmitted to CALL** at most once every few seconds. **Recent transmissions**, under the transmit section,
lists the last 20 frames this tab sent: the time, the source callsign, the destination and path, a short
summary (a message's text, a position, a status, a connect or disconnect) and the part of the app that sent
it: **My radio**, **Messages** or **Terminal**. The list lives in this tab's memory only: the app never sends
it to the instance and never stores it. **Clear** empties it, and signing out does too.

### Set your TNC's timing

When a USB or Bluetooth TNC connects, the browser sends it three KISS settings that decide when it keys the
radio. The values for APRS are the defaults, so most stations never change them. To change one, open
**Advanced: TNC timing** at the end of the forwarding settings, type a whole number from 0 to 255 and leave the
field. The browser keeps your values, and a connected TNC gets a change at once. The
[packet terminal](packet-and-bbs.md#connect-to-a-bbs-or-node) sends the same values to the TNC it opens.

| Setting | Default | What it does |
|---|---|---|
| **TX delay** | 30 (300 ms) | How long the radio transmits before the data starts, in 10 ms steps, while its transmitter comes up. Raise it when other stations miss the start of your frames. |
| **Persist** | 63 (1 in 4) | The chance, (value + 1) in 256, that the TNC sends in a free slot. A lower value leaves the channel to stations that waited with yours. |
| **Slot time** | 10 (100 ms) | How long the TNC waits between tries for a free channel, in 10 ms steps. |

These defaults follow WB2OSZ's *Minimizing APRS Collisions*. **Reset to defaults** restores them. The soundcard
modem and a Meshtastic node receive only, so they take none of these settings.

Key the radio from the TNC's PTT line, not by VOX. A VOX circuit holds the transmitter on for 250 to 500 ms
after the audio stops, so your radio stays on the air after the frame and covers the next station's packet.

### The soundcard modem

**Soundcard AFSK** and **Soundcard HF** decode with Direwolf's modem, by John Langner, WB2OSZ, built to run in
the browser. It decodes plain AX.25, and FX.25 and IL2P frames as well. It runs beside the page, so the map stays
smooth while it listens. The browser downloads the modem when you first connect the soundcard, about 140 kB;
after that, it works offline too.

The status line names the modem, as in **● live (Soundcard (AFSK)) · Direwolf modem (SIMD) · N frames**. When the
browser cannot load Direwolf's modem, the soundcard does not connect, and the page says **Could not connect: the
soundcard modem could not load**, with the reason and what to do about it.

The soundcard links do not decode 9600 baud: that needs the radio's flat 9600-baud data port, which a computer's
microphone input does not pass cleanly. For 9600 baud, use a TNC or the ingest box's [soundcard port](../run/radios/soundcard.md).

## Troubleshooting

| Problem | What to check |
|---|---|
| No connect buttons | The page is not on `https://`, or the browser has none of Web Serial, Web Bluetooth and Web Audio. |
| Only **Soundcard AFSK** shows | The browser is not Chromium-based: use Chrome or Edge for a USB or Bluetooth TNC. |
| **The radio is in use by the packet terminal** | One USB port opens in one place at a time. Close the TNC in the [packet terminal](packet-and-bbs.md) first, or the other way round. |
| Connected, but **0 frames** | The TNC is not in KISS mode, or the radio is on the wrong frequency. With the soundcard, the input level is too low or too high: aim for the loudest level that does not clip. |
| **the soundcard modem could not load** | The browser could not load Direwolf's modem. You are offline and have not connected the soundcard online before: connect it once while online, and the browser keeps the modem for offline use. Or the browser, a policy or an extension blocks WebAssembly: allow it for this site. |
| **Meshtastic node** missing | It needs Web Serial: use desktop Chrome or Edge. |
| The Bluetooth TNC is missing from the dialog | Switch on the TNC's Bluetooth and pair it in the system settings first, if it asks for pairing. A TNC that offers only classic Bluetooth, not Bluetooth Low Energy, cannot connect. |
| Forwarding does nothing | **signed**: sign in first. **secret**: the URL or the secret is wrong; the sysop can check the gateway log. |
| **Sync N heard** says to turn on forwarding | Switch on **Forward to a gateway** and choose the **Auth** first. |

## Next

- [The live map](live-map.md): see the stations around you.
- [Packet terminal & BBS](packet-and-bbs.md): connect to nodes, read and send mail.
