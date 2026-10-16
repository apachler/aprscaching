// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard link's modem Worker (protocol in `soundcardModem.ts`). It waits for one `start`, loads Direwolf's
 * WebAssembly build (the SIMD one where the browser has SIMD), then demodulates the sample blocks the AudioWorklet
 * posts on the port it was handed and posts back the frames. The `.wasm` files are assets of the app's own origin,
 * fetched only when this Worker starts; a module that does not load is reported as a load failure.
 */
import { createDirewolfRx, direwolfHasSimd } from "@aprscaching/direwolf";
import simdWasm from "@aprscaching/direwolf/wasm/direwolf-simd.wasm?url";
import plainWasm from "@aprscaching/direwolf/wasm/direwolf.wasm?url";
import { isModemStart, type ModemReply, type ModemStart } from "./soundcardModem.js";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: ModemReply): void;
}
const scope = self as unknown as WorkerScope;

const why = (e: unknown) => (e as Error)?.message || String(e);

async function start(s: ModemStart): Promise<void> {
  const simd = direwolfHasSimd();
  let rx;
  try {
    rx = await createDirewolfRx({
      sampleRate: s.sampleRate,
      baud: s.baud,
      wasm: new URL(simd ? simdWasm : plainWasm, location.href),
    });
  } catch (e) {
    scope.postMessage({ type: "failed", message: why(e), load: true });
    return;
  }
  scope.postMessage({ type: "ready", simd });
  s.samples.onmessage = (e: MessageEvent) => {
    if (!(e.data instanceof Float32Array)) return;
    const frames = rx
      .push(e.data)
      .map((f) => ({ bytes: f.bytes, fec: f.fec, corrected: f.fec === "none" ? 0 : f.corrected }));
    // frames are a few hundred bytes: copied, not transferred, as two may share one buffer
    if (frames.length) scope.postMessage({ type: "frames", frames });
  };
}

scope.onmessage = (e) => {
  if (!isModemStart(e.data)) return;
  scope.onmessage = null; // one modem per Worker
  start(e.data).catch((err: unknown) => scope.postMessage({ type: "failed", message: why(err), load: false }));
};
