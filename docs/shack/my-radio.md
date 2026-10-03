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
| Only an audio cable from the radio's speaker or data jack to the computer's soundcard | **Soundcard AFSK** | A software modem: decodes 1200-baud packet audio ([AFSK](../glossary.md#afsk), Bell 202), the modem [APRS](../glossary.md#aprs) uses on 144.800 and 144.390 MHz, so no TNC is needed. Receive only |
| A [Meshtastic](../glossary.md#meshtastic) node on USB | **Meshtastic node** | Reads positions of licensed nodes (licensed mode on, callsign as long name) and shows them under their callsign; licence-free nodes are ignored. Receive only |

The page shows only the buttons your browser supports. Firefox and Safari, and every browser on an iPhone or
iPad, cannot talk to USB or Bluetooth radios. There, an [ingest box](../run/radios/ingest-box.md) feeds the
instance instead.

## Connect

1. Open **Settings → My radio (browser)**.
2. Tune your radio to your APRS frequency: 144.800 MHz in Europe, 144.390 MHz in North America.
3. Select the button for your hardware and pick the device in the browser's dialog.
4. The status line shows **● live (USB radio) · N frames**. Heard packets appear under **Live RX**.

**Disconnect** ends the session. The connection lasts as long as the page is open. For a station that runs
around the clock, the instance's sysop runs an [ingest box](../run/radios/ingest-box.md) instead.

## Work off-grid

Your radio and the browser are a station on their own. With no internet at all, the **Field station** panel
lists **Stations heard** in the last hour and a **Local inbox** of the messages your radio heard. The panel
keeps up to 500 heard frames for later.

Back online, turn on forwarding (next section) and select **Sync N heard** to replay those frames to the
instance. Your own beacons stay out of the replay.

## Send what you hear to an instance

1. With a radio connected, or with frames held by the field station, switch on **Forward to a gateway**.
2. Choose the **Auth**:
    - **signed (YOURCALL)**: for a public instance such as aprscaching.net. Your browser's key signs each
      batch, so no password is needed. The instance accepts only your own station's packets this way (any
      [SSID](../glossary.md#ssid) of your callsign). Other stations your radio hears, and Meshtastic nodes, stay in
      your browser. That way no stranger can inject traffic in your name.
    - **secret (self-host)**: for your own instance. Enter the **Gateway base URL** and the **Ingest secret**
      that the instance's [sysop](../glossary.md#sysop) set. With the secret, everything your radio hears is
      forwarded. The browser remembers the URL; it keeps the secret in memory for this session only, so you
      enter it again after a reload.

Packets your browser forwards never verify a find: at most a find is **Logged** (Tier C). Your own radio is
not an independent witness of your own position, and only the instance's own receiving station can make a
find **Radio-verified**. **What your radio can verify**, under the connect buttons, says the same. The
packets still put stations on the map and messages in the log.

## Transmit

Receiving is always allowed. Transmitting needs a [verified callsign](../play/join.md#verify-your-callsign)
and a USB or Bluetooth TNC; until your callsign is verified, the **Transmit** section says so.

1. Switch on **Enable transmit**. You are the licensed control operator and responsible for what you send.
2. Check the **TX callsign**: your callsign with the SSID you type, `-7` by default.
3. Under **Beacon position**, enter the latitude and longitude or select **Use my location**, and add an
   optional comment.
4. Select **Beacon**, then **Transmit** in the confirmation.

Every transmission asks you to confirm first; nothing is sent automatically. To send a text message, see
[Send an APRS message](messages.md#send-an-aprs-message-from-your-radio). Read
[On-air etiquette and rules](on-air.md) before you transmit.

## Troubleshooting

| Problem | What to check |
|---|---|
| No connect buttons | The browser is not Chromium-based, or the page is not on `https://`. |
| Connected, but **0 frames** | The TNC is not in KISS mode, or the radio is on the wrong frequency. With the soundcard, the input level is too low or too high: aim for the loudest level that does not clip. |
| **Meshtastic node** missing | It needs Web Serial: use desktop Chrome or Edge. |
| The Bluetooth TNC is missing from the dialog | Switch on the TNC's Bluetooth and pair it in the system settings first, if it asks for pairing. A TNC that offers only classic Bluetooth, not Bluetooth Low Energy, cannot connect. |
| Forwarding does nothing | **signed**: sign in first. **secret**: the URL or the secret is wrong; the sysop can check the gateway log. |
| **Sync N heard** says to turn on forwarding | Switch on **Forward to a gateway** and choose the **Auth** first. |

## Next

- [The live map](live-map.md): see the stations around you.
- [Packet terminal & BBS](packet-and-bbs.md): connect to nodes, read and send mail.
