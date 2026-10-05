# Tools and plugins

This page shows you how to use the Shack's **Tools** app: switch on a built-in tool, decode a packet, pin a tool
to the rail, and import a plugin someone else wrote. It is for operators; you need no server access. At the end
you know what a tool may do on your behalf and how to take it away again.

## Before you start

- Open **Shack → Tools** (on a phone: **More → Shack → Tools**).
- For tools that transmit: a [verified callsign](../play/join.md#verify-your-callsign) and a radio connected
  to this tab ([Your radio in the browser](my-radio.md)).

## What a tool is

A tool adds one job to the Shack: a decoder, a few `/commands`, a small panel, colours in the packet monitor, or
markers on the map. Tools come in two kinds:

| Kind | Where it comes from | Runs |
|---|---|---|
| **Built-in** | Ships with the app | In the app, under the same permission checks as a plugin |
| **Imported** (a plugin) | A `tool.json` address you give the app, or the **Registry** list | In a sealed sandbox, apart from your session |

Each tool's row shows where it appears (**surfaces**: this Tools screen, the packet terminal, the BBS, the node or
the map) and the permissions it holds (**perms**). Every tool starts switched off.

## The built-in tools

| Tool | What it does |
|---|---|
| **Packet decoder** | Paste a raw TNC2 or APRS-IS line and see every field it carries. Works offline. |
| **PSK31 + CW decoders** | Decode PSK31 and CW (Morse), from text or by ear through the microphone. |
| **7PLUS reassembler** | Collect the parts of a 7PLUS file sent over a BBS and say which are missing. |
| **Monitor colouriser** | Colour heard traffic in the packet monitor by station type. |
| **CTEXT macro pack** | `/cq`, `/73` and `/qth` expand to canned text. |
| **Auto-responder** | Greets a station that connects to you. |
| **Beacon scheduler** | `/beacon` schedules a comment beacon. Needs a verified callsign. |
| **APRS SSID guide** | A table of the usual APRS SSIDs. |
| **Watch & alert** | `/watch <call>` highlights a callsign and logs when it is heard. |
| **MHeard** | The stations heard recently, from your radio and the live APRS layer. |
| **Auto-status** | `/autostatus` sends a status line on a timer. Needs a verified callsign. |
| **Grid & bearing** | `/grid` gives distance and bearing between two Maidenhead locators. |
| **Unit converter** | `/conv` converts km, miles, feet, knots and temperatures. |
| **CW encoder** | `/cw <text>` turns text into dots and dashes. |
| **Station DB (NAMES.GP)** | Sorts heard stations by type and shares that with other tools. |
| **Info / menu responder** | Answers a connected station's INFO, MENU and WHOIS. |
| **Away note** | An away message, and a short note a connected station can leave. |
| **Connect bell** | Rings when a station connects. |
| **Link ping (RTT)** | The round-trip time to the station you are connected to. |
| **Scheduled query (GPAUTO)** | Runs a connect, wait, send, disconnect script against a BBS or cluster. |
| **Block art (GIP)** | Shows CP437/ANSI block art in a panel. |
| **Map waypoints** | `/wp <locator>` drops a marker on the map. |

## Switch a tool on

1. Find the tool's row and turn its switch on.
2. The tool's panel, decoder or commands appear: decoders and commands in the **Decode** and **Run a tool
   command** sections below the list, panels under the list, monitor colours in the packet terminal.

Turn the switch off to stop the tool. A reload switches every built-in tool off again.

## Decode a packet

1. Switch on **Packet decoder**. The **Decode** section appears with **APRS packet** selected.
2. Paste a line in TNC2 format, or select **Use a sample**, for example:

    ```
    OE8APR-9>APRS,WIDE1-1,qAR,OE8XBM-10:!4703.00N/01526.00E>mobile
    ```

3. Select **Decode**.

The result shows the sender, the destination and path, whether the line says it was heard on **RF** or came over
**APRS-IS**, the packet type, and every field: position (plain, compressed or Mic-E), course, speed, altitude,
objects and items, messages with acknowledgements, bulletins, status, weather and telemetry. In the example,
`qAR,OE8XBM-10` is the [q-construct](../glossary.md#q-construct): where the packet entered APRS-IS. The decoder
runs in your browser, so it works without a connection.

## Pin a tool to the rail

1. Select the pin button on the tool's row (**Pin Packet decoder to the rail**).
2. The tool appears on the left rail, below the Shack apps you pinned, with its icon. On a phone it is in
   **More**. An imported tool shows a plug icon and its title.
3. Select it on the rail to open **Tools** with that tool switched on and in view; a decoder opens ready to paste.

Select the pin again (**Unpin …**) to take it off. Your pins are kept in this browser and, when you are signed in,
with your account, so another device shows them too. An imported tool's pin shows only while that tool is loaded,
and goes when you switch the tool off or remove it.

## Import a plugin

1. Under **Registry**, select **Import…** beside a listed tool. Or paste a tool's `tool.json` address under
   **Import a tool** and select **Import…**.
2. Read the prompt: who wrote the tool, the permissions it asks for, where it appears, the addresses it may
   reach, and its trust label.
3. Select **Approve + run** to start it, or **Cancel**.

The tool appears under **Import a tool** with its own switch, pin and **Remove** button. It runs until you remove
it or reload the page; after a reload, import it again.

### What each permission means

| Permission | The tool may |
|---|---|
| `panel` | Show a small panel of text, tables and bars. It cannot draw anything else on the page. |
| `command` | Answer `/commands` you type, here or in the terminal and BBS. |
| `monitor` | Read the frames your radio hears, and colour or hide lines in the packet monitor. |
| `decoder` | Add a decoder to the **Decode** list. |
| `event` | React when a station connects, a frame is heard, or a minute passes. |
| `map` | Put markers on the map. |
| `ipc` | Talk to other tools you run: share what it learns and ask them questions. |
| `network` | Reach the internet, and only the addresses the prompt lists under **connects to**. Without this permission it reaches nothing. |
| `beacon` | Schedule a beacon under your callsign. |
| `tx` | Ask to transmit under your callsign. |
| `geo` | Read your device's location. |

A tool never sees your session, your passkeys or the keys this browser holds for you, and no permission lets it
change how finds are verified.

Transmitting is gated three ways. The tool needs the `tx` or `beacon` permission; the app checks that your
callsign is [verified](../play/join.md#verify-your-callsign) each time the tool asks; and your radio keys only
on a link this tab may transmit on, which needs your [consent for this tab](my-radio.md#allow-transmitting-for-this-tab).
A scheduled query connects through the packet terminal's TNC, under that consent. A beacon or a status line a
built-in tool asks for shows as a notice in the app and does not reach the radio. Imported tools cannot transmit,
schedule beacons, react to events or draw on the map yet, whatever they ask for: they get commands, colours,
panels, decoders, other tools and the network.

### The trust labels

| Label | Meaning | What to do |
|---|---|---|
| **Signed · registry-listed author key** | The registry lists this tool at this address, and the author key it lists signed the manifest. | Import if the permissions fit the job. |
| **Signed · matches the key you trusted before** | You accepted this author's key before, from another tool or an earlier import. | Import if the permissions fit the job. |
| **Signed · unknown author key (trust-on-first-use)** | Signed, but nobody vouches for the key. Approving remembers it for this author. | Import only if you trust where the address came from. |
| **Unsigned · you're trusting the URL only** | No signature. Whoever runs that server decides what you get. | Import only from a server you trust. |
| **Author key CHANGED since you last trusted it — refused** | The author's key is not the one you accepted, or not the one the registry lists. | Blocked. Ask the author, through a channel you trust, whether they changed their key. |
| **Signature INVALID — refused** | The manifest was changed after it was signed. | Blocked. Do not look for another copy; tell the author. |

A signature covers the manifest, including the script's address, but not the script itself. A label vouches for
who signed the manifest, not for what the script does; the permissions are what limit it.

After a key-change warning, the app keeps refusing that author's new key. If the author confirms the change,
remove the old key: clear this site's data in your browser's settings. That also clears your pins, settings
and offline areas on this device.

## Switch off or remove a plugin

- Turn its switch off to stop it. Its panel, colours, commands and decoder go, and its pin leaves the rail.
- Select **Remove** to unload it. Its sandbox closes and nothing of it stays. Reloading the page removes every
  imported tool.

## Where tools keep data

Everything stays in this browser:

- A tool's own notes (watched calls, heard stations, away notes) live in memory and end with the page.
- Your pins live in this browser and, when you are signed in, with your account.
- The author keys you accepted live in this browser's storage. Clearing this site's data removes them.

## Stay safe

- Grant only the permissions a tool needs for its job. A unit converter has no reason to ask for `network`.
- Check every address under **connects to**. A tool can send what it sees to those addresses.
- Prefer registry-listed tools, and import others only from an author you know.
- Take a key-change warning seriously: it is the one sign that someone else may be signing as the author.
- Remove a tool you no longer use.

## Next

- [Packet terminal & BBS](packet-and-bbs.md): where most tools show their colours and commands.
- [The tool registry](../contribute/tool-registry.md): how the registry works, for authors and sysops.
