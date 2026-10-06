# The Shack at a glance

The Shack is the radio side of APRScaching: packet-radio apps that run in your browser and drive a radio
connected to your own computer. This page is for operators who know APRS, TNCs and packet; it shows what each
app does and where to read more.

A laptop and a radio are a complete station, even with no internet: the apps talk to a USB or Bluetooth
[TNC](../glossary.md#tnc), or to the soundcard, straight from the browser. Open the Shack from **Shack** in
the left rail (on a phone: **More → Shack**). Each app opens its own screen. The pin button next to an app, or next
to a tool inside **Tools**, puts it on the left rail; on a phone, pinned apps and tools are in **More**.

## Your journey

1. [Your radio in the browser](my-radio.md): connect a TNC, a Mobilinkd or a soundcard.
2. [The live map](live-map.md): stations, spots and MeshCom nodes as they are heard.
3. [Packet terminal & BBS](packet-and-bbs.md): connect to nodes, read and send mail.
4. [Tools and plugins](tools.md): install tools from the registry to decode packets, CW and PSK31, and more.
5. [Messages over APRS and MeshCom](messages.md): read, send and acknowledge messages.
6. [Rig control & weather](rig-weather.md): tune your radio, report your weather station.
7. [On-air etiquette and rules](on-air.md): before you transmit.

## The apps

![The Shack app launcher](../assets/shots/shack-launcher-desktop.webp){ width="720" loading=lazy }

| App | What it does | Who | Read more |
|---|---|---|---|
| **Packet terminal** | A multi-channel connected-mode terminal: connect to BBSes, nodes and other stations over a [KISS](../glossary.md#kiss) TNC on USB or Bluetooth. | everyone | [Connect to a BBS or node](packet-and-bbs.md#connect-to-a-bbs-or-node) |
| **BBS** | Store-and-forward mail, bulletins and threads on the instance's [BBS](../glossary.md#bbs). Bulletins are open to everyone; your mail needs you signed in as your callsign. | everyone | [Use the instance's BBS](packet-and-bbs.md#use-the-instances-bbs) |
| **Tools** | Signed plugins you install from a registry: the packet decoder for raw [APRS](../glossary.md#aprs) and [AX.25](../glossary.md#ax25) lines, CW and PSK31 from your microphone, macros, panels and more. Each tool can be pinned to the rail. | everyone | [Tools and plugins](tools.md) |
| **Rig control** | Tune your radio over USB ([CAT](../glossary.md#cat)). | everyone | [CAT rig control](rig-weather.md#cat-rig-control) |
| **[NET/ROM](../glossary.md#netrom) node** | The instance's node: routing table, [digipeater](../glossary.md#digipeater), [sysop](../glossary.md#sysop) console. | sysop | [Packet: BBS & NET/ROM node](../run/radios/packet-node.md) |
| **Remote box** | Send commands to the instance's [ingest box](../glossary.md#ingest-box) without opening a port on it. | sysop | [Remote control of your box](../run/radios/remote-box.md) |

The last two apps manage the instance's always-on station, so only its sysop sees them.

Three things live outside the launcher:

- **Settings → My radio (browser)**: receiving, forwarding and transmitting APRS with your own radio
  ([Your radio in the browser](my-radio.md)).
- **Messages** in the left rail: the APRS and MeshCom messages the instance hears
  ([Messages over APRS and MeshCom](messages.md)).
- **Search & filter → Live layers** on the map: live stations, MeshCom nodes and activity spots
  ([The live map](live-map.md)).

## CW and PSK31 by ear

1. Open **Shack → Tools** and switch on **PSK31 + CW decoders**.
2. Under **Decode**, pick **CW (Morse)** or **PSK31**, select **Listen (mic)** and allow the microphone.
3. Hold your phone or laptop to the radio's speaker, or connect the radio's audio output to the line-in.

CW (Morse) and PSK31 appear as text while you listen. The decoders follow slightly off-tune and noisy
signals, and everything runs in the browser. **Stop** ends it.

## Tools and plugins

**Tools** runs the tools you install, from the **Registry** list or by a `tool.json` address; the app ships with
none. The project registry, which comes with every instance, lists the packet decoder and twenty-two other tools.
Each tool runs in a sealed sandbox with only the permissions you approve, the install prompt says who signed it,
and your installed tools follow your account. [Tools and plugins](tools.md) lists the project's tools, explains
every permission and trust label, and shows how to pin, switch off and remove a tool.

## Next

- [Your radio in the browser](my-radio.md): connect your radio first.
- [On-air etiquette and rules](on-air.md): before you transmit.
