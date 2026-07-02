// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * audioDecode.ts — the thin Web Audio mic capture that drives the CW + PSK31 front-ends. It
 * taps mono PCM off the microphone (or line-in) and streams it into the pure `StreamDecoder`
 * (`@aprsweb/tools`), which re-runs the robust batch decoder over a bounded window and returns the text so
 * far — so callers get LIVE text via `onText`, not just a result on stop. The DSP is all pure + unit-tested
 * (`stream.test.ts`, `psk31robust.test.ts`); this file is only the browser plumbing, and it is itself
 * exercised headlessly by `tools/e2e/audio-mic.mjs` (Chromium fake-audio capture) — no longer purely
 * validate-at-deploy. Chromium-first; needs mic permission.
 *
 * Sample tap: an **AudioWorklet** (off the main thread — keeps sample handling away from the map render loop,
 * per `.claude/rules/css.md`), with a **ScriptProcessorNode fallback** for engines without worklet support.
 */
import { makeStreamDecoder, type DecodeMode } from "@aprsweb/tools";

export type AudioMode = DecodeMode;
export interface AudioCapture { stop(): Promise<string> }
export interface ListenOpts {
  pitchHz?: number; carrierHz?: number; baud?: number;
  /** Force the AudioContext sample rate (else the browser default). */ sampleRate?: number;
  /** Live callback with the full decoded text so far, fired as audio arrives. */ onText?: (text: string) => void;
}

export const audioDecodeSupported = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";

// The worklet processor: copy each 128-sample input frame and post it to the main thread (which owns the
// pure decoder). Kept as a string → Blob URL so there is no bundler asset wiring; it is engine-portable.
const TAP_WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) { const c = new Float32Array(ch); this.port.postMessage(c, [c.buffer]); }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

/** Start capturing the mic; the returned `stop()` ends capture and returns the final decoded text. */
export async function listenDecode(mode: AudioMode, opts: ListenOpts = {}): Promise<AudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ac = opts.sampleRate ? new AudioContext({ sampleRate: opts.sampleRate }) : new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const decoder = makeStreamDecoder(mode, ac.sampleRate, { carrierHz: opts.carrierHz, pitchHz: opts.pitchHz, baud: opts.baud });
  const onChunk = (samples: Float32Array) => { const text = decoder.push(samples); opts.onText?.(text); };

  let teardown: () => void;
  // Preferred path: AudioWorklet (off-main-thread tap).
  let usedWorklet = false;
  if (ac.audioWorklet) {
    try {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
      await ac.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ac, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => onChunk(e.data as Float32Array);
      src.connect(node); node.connect(ac.destination);   // connect to pull the graph; the node emits silence
      teardown = () => { node.port.onmessage = null; node.disconnect(); src.disconnect(); };
      usedWorklet = true;
    } catch { /* fall through to ScriptProcessor */ }
  }
  if (!usedWorklet) {
    // Fallback: the deprecated ScriptProcessorNode (still the universal raw-sample tap).
    const proc = ac.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(ac.destination);
    teardown = () => { proc.onaudioprocess = null; proc.disconnect(); src.disconnect(); };
  }

  return {
    async stop(): Promise<string> {
      teardown();
      for (const t of stream.getTracks()) t.stop();
      const text = decoder.flush();
      await ac.close();
      return text;
    },
  };
}
