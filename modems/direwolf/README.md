# @aprscaching/direwolf

Direwolf's modem, compiled to WebAssembly: one receiver and one transmitter per audio channel, for 300 bd
(1600/1800 Hz), 1200 bd (Bell 202) and 9600 bd (G3RUH), in plain AX.25, FX.25 and IL2P. It runs in Node, Bun and
browsers from the same build. Direwolf is by John Langner, WB2OSZ (<https://github.com/wb2osz/direwolf>).

```ts
import { createDirewolfRx, createDirewolfTx } from "@aprscaching/direwolf";

const rx = await createDirewolfRx({ sampleRate: 48000, baud: 1200 });
for (const frame of rx.push(pcm)) console.log(frame.fec, frame.bytes); // AX.25 bytes without the FCS
rx.dcd; // carrier detect, for CSMA

const tx = await createDirewolfTx({ sampleRate: 48000, baud: 9600, mode: "il2p", txdelayMs: 300, txtailMs: 30 });
const audio = tx.modulate(frame); // Int16Array: preamble, frame, tail; PTT stays with the caller
```

- **Receive.** `push()` takes 16-bit or float mono PCM and returns the frames it completed, each with the framing
  it arrived in (`none`, `fx25`, `il2p`) and the symbols the FEC corrected. The core listens for FX.25 and IL2P
  all the time; `fx25: false` or `il2p: false` drops those frames. `reset()` clears the receive state, for the
  moment after the station's own transmission.
- **Transmit.** `modulate()` adds the FCS, bit-stuffs, and sends `txdelayMs` of HDLC flags (or the IL2P preamble),
  the frame and `txtailMs` of the same. FX.25 takes 16, 32 or 64 check bytes; a frame too long for that code
  goes out as plain AX.25, as in Direwolf.
- **Loading.** By default the package fetches `wasm/direwolf-simd.wasm` (when `WebAssembly.validate` accepts a
  SIMD probe) or `wasm/direwolf.wasm` next to itself: with `fetch` for an `http(s):` URL, with `node:fs` for a
  `file:` URL. A bundler or a host that serves the files elsewhere passes `wasm` (a URL, the bytes or a compiled
  `WebAssembly.Module`). Each receiver and transmitter is its own instance of the compiled module, because
  Direwolf keeps a modem's state in globals.

## Layout

| Path | What |
|---|---|
| `src/glue.c` | The C entry points over Direwolf's receive core and transmit path, with an in-memory audio sink (GPL-2.0-or-later) |
| `src/index.ts` | The TypeScript interface and the loader |
| `vendor/direwolf/` | Direwolf 1.8.1's sources, unmodified, with its `LICENSE`, `UPSTREAM` (tag and commit) and `SHA256SUMS` |
| `wasm/` | The built loader and the two modules (SIMD and plain), committed |
| `build.sh` | The build, with the pinned Emscripten version |
| `test/` | Loopback in every mode and speed, FEC under a noise burst, and a recorded fixture |

## Building

The built files are committed, so working on the TypeScript or the tests needs no compiler. After a change to
`src/glue.c`, `build.sh` or the vendored sources, rebuild with the Emscripten version `build.sh` pins:

```sh
git clone --depth 1 https://github.com/emscripten-core/emsdk && emsdk/emsdk install 6.0.12 && emsdk/emsdk activate 6.0.12
. emsdk/emsdk_env.sh && modems/direwolf/build.sh
pnpm --filter @aprscaching/direwolf test
```

The build is byte-reproducible: CI rebuilds it and fails when the result differs from the committed files.
`build.sh native` builds a native driver (`build/glue rx file.wav` / `build/glue tx …`) for cross-checks against
Direwolf's own `atest`. `pnpm --filter @aprscaching/direwolf fixture` rewrites the receive fixture.

## Licence

AGPL-3.0-or-later, like the rest of the application; `src/glue.c` and the vendored Direwolf files are
GPL-2.0-or-later, which combines with it under GPLv3 §13. [`NOTICE`](NOTICE) has the details and the source
obligations. This package must stay out of the MIT `packages/*`: nothing there may import it.
