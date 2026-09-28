# The Shack

The Shack is the radio side of aprscaching: a set of packet-radio apps that run in your browser. Open it from
**Shack** in the left rail (on a phone: **You → Advanced — the Shack**). Each app opens its own screen, and
the pin button next to an app puts it on the left rail for one-tap access.

Most apps work with a radio connected to **your own computer** — through a USB or Bluetooth TNC, or the
soundcard — so a laptop and a radio are a complete station, even with no internet. Two apps manage the
instance's always-on station and are shown only to its operator.

## The apps

| App | What it does | Who |
|---|---|---|
| **Packet terminal** | A multi-channel connected-mode terminal: connect to BBSes, nodes and other stations over your TNC (USB or Bluetooth). | everyone |
| **BBS** | Store-and-forward mail, bulletins and threads on the instance's BBS. | everyone |
| **Packet decoder** | Paste a raw APRS or AX.25 line and see every field decoded. | everyone |
| **Tools** | Plugins and signal decoders, including **CW and PSK31 decoding from your microphone**. | everyone |
| **Rig control** | Tune your radio over USB (CAT). See [Rig control](my-radio.md#rig-control). | everyone |
| **NET/ROM node** | The instance's node: routing table, digipeater, sysop console. | operator |
| **Remote box** | Send commands to the instance's ingest box without opening a port on it. | operator |

Your radio connection itself — receiving, forwarding and transmitting APRS — lives in
**Settings → My radio (browser)**: see [Your radio in the browser](my-radio.md).

## Live stations

Turn on **Search & filter → Live layers → Live stations** to see APRS stations on the map as they are heard.
Moving stations show a heading arrow. Tap a station for its page: symbol, speed and course, altitude,
recent track, weather, and its raw packets.

## Packet decoder

Paste a line in the usual TNC2 format, for example

```
OE8APR-9>APRS,WIDE1-1,qAR,OE8XBM-10:!4703.00N/01526.00E>mobile
```

and the decoder shows what it contains: position (plain, compressed or Mic-E), course, speed, altitude,
objects and items, messages with acknowledgements, bulletins, status, weather and telemetry.

## CW and PSK31 by ear

In **Tools**, press **Listen (mic)**. Hold your phone or laptop to the radio's speaker, or connect the audio
output to the line-in. CW (Morse) and PSK31 appear as text while you listen; **Stop** ends it. The decoders
follow slightly off-tune and noisy signals, and everything runs in the browser.

## BBS, node and forwarding

The instance's BBS forwards mail with the wider packet network (FBB forwarding), and its NET/ROM node links
with other nodes. Setting those up is the operator's job: see [Packet BBS & node](../operate/packet.md).

## Remote box and spots

- **Remote box** (operator) — the web app queues commands and the ingest box collects them over its own
  outbound connection, so the box needs no open port. Transmit commands need a verified callsign.
- **Spots** — when the operator enables them, POTA and SOTA activations (and DX-cluster, RBN and
  PSKReporter spots) appear on the map; filter them under **Search & filter → Live layers**.

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

### For plugin authors

- **Capabilities** declare what a tool may do (`command`, `monitor`, `event`, `decoder`, `panel`, `map`,
  `ipc`, `beacon`, `network`, `tx`, `geo`). `beacon`, `network`, `tx` and `geo` need an extra grant, and
  `tx`/`beacon` still pass the transmit gate.
- **Surfaces** declare where a tool appears (`web`, `terminal`, `bbs`, `node`, `map`).
- Tools describe panels as a serialisable node tree (text, key/value, badges, bars, tables, CP437/ANSI block
  grids) and map layers as typed points; the host renders them. Nothing a tool emits touches the page
  directly.
- The host routes generic verbs (register a command, subscribe to an event, add a decoder, set a panel,
  request a transmit) and an opaque pub/sub bus between tools, without interpreting a tool's behaviour.
- A tool ships a signed manifest (`tool.json`) checked against an authority-signed registry whose key the
  app pins. Sign your own tools with the [`toolkey` CLI](../reference/cli.md#toolkey).
