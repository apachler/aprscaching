# The Shack

The Shack is the operator side of the app — a real packet-radio bench. It is revealed progressively, so the
cacher never sees it, and each app opens into its own surface.

## Decoder & live stations

The pure decoder (`@aprscaching/aprs`) turns any raw frame into typed data: uncompressed, base-91 compressed, and
MIC-E positions (course, speed, altitude, ambiguity), objects and items, messages (with acks and bulletins),
status, weather, and telemetry. Paste a raw TNC2 line into the inspector (`POST /api/decode`) to see it
decoded field-by-field.

Ingested packets feed a live **station registry** and map — moving stations show a heading arrow, and each
station has a page with its symbol, speed/course, altitude, recent track, weather, and raw packets
(`/api/stations/:call`, `/:call/series`, `/:call/packets`).

## Off-air CW & PSK31

The bench decodes two modes straight from the microphone (or line-in), in the browser:

- **CW (Morse)** — a Goertzel single-bin tone detector turns audio into a keyed on/off envelope, then into
  text.
- **PSK31** — a differential BPSK demodulator with a robust weak-signal path (AGC, carrier recovery by
  squaring, and symbol-timing recovery) for off-tuned or noisy signals.

Live capture uses an AudioWorklet tap feeding a streaming decoder, so text appears as you listen. Press
**Listen (mic)** in the decode box.

## Tools plugin platform

The Shack is extensible: third parties can ship **tool plugins** that add commands, decoders,
colourisers, panels, and map layers.

- **Capabilities** declare what a tool may do (`command`, `monitor`, `event`, `decoder`, `panel`, `map`,
  `ipc`, `beacon`, `network`, `tx`, `geo`). The gated ones (`beacon`, `network`, `tx`, `geo`) need extra
  grant, and `tx`/`beacon` still pass the runtime transmit gate — a tool can never bypass the trust engine.
- **Surfaces** declare where a tool appears (`web`, `terminal`, `bbs`, `node`, `map`).
- **Declarative output.** Tools describe panels as a serialisable node tree (text, key/value, badges, bars,
  tables, CP437/ANSI block grids) and map layers as typed points; the host renders them with real semantic
  elements and theme tokens. Nothing a tool emits touches the DOM directly.
- **The host is a blind router.** It exposes generic verbs (register a command, subscribe to an event, add a
  decoder, set a panel, request a transmit) and never interprets a tool's behaviour — all logic lives in the
  tool.
- **Inter-tool IPC.** Tools cooperate over an opaque pub/sub bus and named services; the host routes messages
  without inspecting their payloads.

### Trust for imported tools

Third-party tools carry a signed manifest (`tool.json`) and are identified against an **authority-signed
registry** whose key the app pins. On import a tool resolves to `verified` (registry-known key), `known`
(trust-on-first-use pin), `self-signed`, `unsigned`, or `invalid` — `invalid` is blocked, `unsigned` is
allowed with a warning. Untrusted tools run in a **locked-down Web Worker** with network access shadowed
unless the `network` capability is granted, and their contributions cross a `postMessage` bridge. Sign your
own tools with the [`toolkey` CLI](../reference/cli.md#toolkey).

## Remote box & live spots

- **Remote control** — drive your own ingest box from the Shack without any inbound port; the box pulls
  queued commands over its outbound connection. Transmit commands need a verified callsign.
- **Live activity spots** — overlay POTA / SOTA / DX-cluster / RBN / PSKReporter spots on the map, filtered
  and de-duplicated, when the instance enables `SPOTS_ENABLED`.
