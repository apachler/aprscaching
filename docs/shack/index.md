# The Shack at a glance

The Shack is the radio side of aprscaching: a set of packet-radio apps that run in your browser. Open it from
**Shack** in the left rail (on a phone: **You → Advanced — the Shack**). Each app opens its own screen, and
the pin button next to an app puts it on the left rail for one-tap access.

Most apps work with a radio connected to **your own computer** — through a USB or Bluetooth [TNC](../glossary.md#tnc), or the
soundcard — so a laptop and a radio are a complete station, even with no internet. Two apps manage the
instance's always-on station and are shown only to its operator.

## Your journey

1. [Your radio in the browser](my-radio.md): connect a TNC, a Mobilinkd or a soundcard.
2. [The live map](live-map.md): stations, spots and MeshCom nodes as they are heard.
3. [Packet decoder & BBS](packet-and-bbs.md): decode frames, read and send mail.
4. [Rig control & weather](rig-weather.md): tune your radio, report your weather station.
5. [On-air etiquette and rules](on-air.md): before you transmit.

## The apps

![The Shack app launcher](../assets/shots/shack-launcher-desktop.webp){ width="720" loading=lazy }

| App | What it does | Who |
|---|---|---|
| **Packet terminal** | A multi-channel connected-mode terminal: connect to BBSes, nodes and other stations over your TNC (USB or Bluetooth). | everyone |
| **BBS** | Store-and-forward mail, bulletins and threads on the instance's BBS. Bulletins are open to everyone; your mail needs you signed in as your callsign. | everyone |
| **Packet decoder** | Paste a raw [APRS](../glossary.md#aprs) or [AX.25](../glossary.md#ax25) line and see every field decoded. | everyone |
| **Tools** | Plugins and signal decoders, including **CW and PSK31 decoding from your microphone**. | everyone |
| **Rig control** | Tune your radio over USB ([CAT](../glossary.md#cat)). See [Rig control](rig-weather.md#step-by-step). | everyone |
| **[NET/ROM](../glossary.md#netrom) node** | The instance's node: routing table, [digipeater](../glossary.md#digipeater), [sysop](../glossary.md#sysop) console. | operator |
| **Remote box** | Send commands to the instance's [ingest box](../glossary.md#ingest-box) without opening a port on it. | operator |

Your radio connection itself — receiving, forwarding and transmitting APRS — lives in
**Settings → My radio (browser)**: see [Your radio in the browser](my-radio.md).

## CW and PSK31 by ear

In **Tools**, press **Listen (mic)**. Hold your phone or laptop to the radio's speaker, or connect the audio
output to the line-in. CW (Morse) and PSK31 appear as text while you listen; **Stop** ends it. The decoders
follow slightly off-tune and noisy signals, and everything runs in the browser.

## Tools and plugins

**Tools** also runs third-party plugins: extra commands, decoders, colour schemes, panels and map layers.
When you import a plugin, the app checks who signed it:

| Shown as | Meaning |
|---|---|
| **verified** | Signed by a key the project's registry knows. |
| **known** | You accepted this signer before. |
| **self-signed** / **unsigned** | Allowed, with a warning. |
| **invalid** | The signature does not match — blocked. |

Plugins you don't fully trust run in a sealed-off sandbox without network access unless you grant it, and no
plugin can transmit or change how finds are verified without passing the same checks as you.

## Next

- [Your radio in the browser](my-radio.md).
- [On-air etiquette and rules](on-air.md).
