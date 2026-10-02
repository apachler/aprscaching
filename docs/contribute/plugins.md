# Writing a Shack plugin

This part is for developers writing a plugin; using plugins needs none of it.

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

## Next

- [Command-line tools](../reference/cli.md#toolkey): signing a tool.
