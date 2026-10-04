# Writing a Shack plugin

This page is for developers who write a plugin (a *tool*) for the Shack's **Tools** app. It sets out the
manifest, the permissions a tool asks for, where it appears and how it is signed; using plugins is under
[Tools and plugins](../shack/index.md#tools-and-plugins).

## The manifest

A tool ships a manifest, `tool.json`, which `@aprscaching/tools` validates:

| Field | Required | Content |
|---|---|---|
| `name` | yes | Unique id: lowercase, 2 to 40 characters of `a-z`, `0-9` and `-` |
| `title` | yes | The label users see |
| `author` | yes | The author's callsign |
| `version` | yes | The tool's version |
| `permissions` | yes | The capabilities the tool asks for (below) |
| `surfaces` | no | Where the tool appears (below); `["web"]` when left out |
| `remote` | no | `true` lets a remote connected station invoke the tool's commands |
| `description` | no | One line for the registry and the import prompt |
| `entry` | for an imported tool | The URL or path of the JavaScript module the sandbox runs |
| `connect` | with `network` | The `https://` or `wss://` origins the tool reaches, at most 8, without a path |
| `pubkey` | to sign | The author's raw Ed25519 public key, base64url |
| `signature` | to sign | A detached Ed25519 signature over the canonical manifest (every field but `signature`) |

## Capabilities

| Capability | Lets the tool |
|---|---|
| `command` | Register a `/word` in the terminal or the BBS |
| `monitor` | Read heard frames and add monitor colourisers and filters |
| `event` | Hook lifecycle events such as a connect, a find or a spot |
| `decoder` | Add an audio or signal decoder |
| `panel` | Add a small panel |
| `map` | Add a declarative map layer |
| `ipc` | Publish and subscribe on the bus between tools, and offer or call named services |
| `beacon` | Schedule a beacon. Needs a separate grant and passes the transmit gate |
| `network` | Make an outbound request to the origins in `connect`. Needs a separate grant |
| `tx` | Transmit a frame. Needs a separate grant and passes the transmit gate |
| `geo` | Read the device's location. Needs a separate grant |

The transmit gate checks that the user's callsign is control-verified each time the tool transmits. No
capability lets a tool change how finds are verified.

## Surfaces

| Surface | Where the tool's contributions appear |
|---|---|
| `web` | The **Tools** app |
| `terminal` | The packet terminal: monitor colours, `/commands`, panels |
| `bbs` | The BBS |
| `node` | The NET/ROM node console |
| `map` | The map |

## Where a tool runs

An imported tool's script runs in a Web Worker inside a hidden, sandboxed frame with an opaque origin. From
there the tool:

- reaches nothing of the app's: its cookies, session, local storage, IndexedDB (where the device key lives),
  Cache Storage and service worker belong to another origin;
- reaches the network only with the `network` grant, and then only the origins in `connect`. The frame's
  Content-Security-Policy blocks every other request, the app's own origin and API included. A request carries
  no cookies of the user's;
- talks to the app only through the host's messages: its commands, decoders, panel and colour rules, and the
  bus between tools when it holds `ipc`.

Removing a tool removes its frame, which ends the worker.

## What a tool emits

A tool never touches the page. It describes a panel as a serialisable node tree (text, key and value rows,
badges, bars, tables, and CP437/ANSI block grids) and a map layer as typed points; the host renders them with
real elements and the theme's tokens. The host routes generic verbs (register a command, subscribe to an
event, add a decoder, set a panel, request a transmit) and an opaque bus between tools, without interpreting
a tool's behaviour.

## Signing

The app checks a signed manifest against an authority-signed registry whose key it pins: a tool whose key
matches its registry entry shows as verified. Sign your own tools with the
[`toolkey` CLI](../reference/cli.md#toolkey).

## Next

- [Command-line tools](../reference/cli.md#toolkey): signing a tool.
- [Testing & verification](testing.md): the checks a change runs through.
