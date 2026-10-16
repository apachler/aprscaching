// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard link's modem Worker (protocol in `soundcardModem.ts`). It waits for one `start`, opens the
 * receiver (Direwolf's WebAssembly build, the SIMD one where the browser has SIMD, or the built-in AFSK modem),
 * then demodulates the sample blocks the AudioWorklet posts on the port it was handed and posts back the frames.
 * The `.wasm` files are assets of the app's own origin, fetched only when this Worker starts.
 */
import { AfskRx, BELL_202, HF_300 } from "@aprscaching/aprs";
import { createDirewolfRx, direwolfHasSimd } from "@aprscaching/direwolf";
import simdWasm from "@aprscaching/direwolf/wasm/direwolf-simd.wasm?url";
import plainWasm from "@aprscaching/direwolf/wasm/direwolf.wasm?url";
import {
  isModemStart,
  openAudioRx,
  type AudioRx,
  type HeardAudioFrame,
  type ModemReply,
  type ModemStart,
} from "./soundcardModem.js";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: ModemReply): void;
}
const scope = self as unknown as WorkerScope;

function builtinRx(s: ModemStart): AudioRx {
  let heard: HeardAudioFrame[] = [];
  const rx = new AfskRx(
    s.sampleRate,
    (bytes) => heard.push({ bytes, fec: "none", corrected: 0 }),
    s.baud === 300 ? HF_300 : BELL_202,
  );
  return {
    push(pcm) {
      heard = [];
      rx.push(pcm);
      return heard;
    },
  };
}

async function start(s: ModemStart): Promise<void> {
  const simd = direwolfHasSimd();
  try {
    const opened = await openAudioRx(s.demod, {
      async direwolf() {
        const rx = await createDirewolfRx({
          sampleRate: s.sampleRate,
          baud: s.baud,
          wasm: new URL(simd ? simdWasm : plainWasm, location.href),
        });
        return {
          push: (pcm) =>
            rx.push(pcm).map((f) => ({ bytes: f.bytes, fec: f.fec, corrected: f.fec === "none" ? 0 : f.corrected })),
        };
      },
      builtin: () => builtinRx(s),
    });
    scope.postMessage({
      type: "ready",
      kind: opened.kind,
      simd: opened.kind === "direwolf" && simd,
      fallback: opened.fallback,
    });
    s.samples.onmessage = (e: MessageEvent) => {
      if (!(e.data instanceof Float32Array)) return;
      const frames = opened.rx.push(e.data);
      // frames are a few hundred bytes: copied, not transferred, as two may share one buffer
      if (frames.length) scope.postMessage({ type: "frames", frames });
    };
  } catch (e) {
    scope.postMessage({ type: "failed", message: (e as Error)?.message || String(e) });
  }
}

scope.onmessage = (e) => {
  if (!isModemStart(e.data)) return;
  scope.onmessage = null; // one modem per Worker
  void start(e.data);
};
