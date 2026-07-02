/**
 * audioDecode.ts — the thin Web Audio mic capture that drives the CW + PSK31 front-ends (docs/28 §6). It
 * captures mono PCM from the microphone (or line-in) into a buffer, then runs the pure decoder pipeline
 * (`cwKeyEvents → morseFromTiming → decodeMorse`, or `psk31Demod → decodeVaricode`). Chromium-first, needs
 * mic permission, and there's no mic in headless CI → **validate-at-deploy**. Carrier/pitch use fixed
 * defaults; a Costas/AGC + symbol-timing loop for weak signals is a future refinement (the decoders are
 * pure + already unit-tested, so only the live front-end is unverified here).
 */
import { cwKeyEvents, morseFromTiming, decodeMorse, psk31Demod, decodeVaricode } from "@aprsweb/tools";

export type AudioMode = "cw" | "psk31";
export interface AudioCapture { stop(): Promise<string> }
export const audioDecodeSupported = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";

/** Start capturing the mic; the returned `stop()` ends capture and returns the decoded text. */
export async function listenDecode(mode: AudioMode, opts: { pitchHz?: number; carrierHz?: number } = {}): Promise<AudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const sr = ac.sampleRate;
  const chunks: Float32Array[] = [];
  // ScriptProcessorNode is deprecated but the simplest universally-available raw-sample tap for a capture
  // buffer (an AudioWorklet is the modern path; not needed for a bounded manual capture).
  const proc = ac.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ac.destination);   // must be connected to run; we write no output (silent)

  return {
    async stop(): Promise<string> {
      proc.disconnect(); src.disconnect();
      for (const t of stream.getTracks()) t.stop();
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const buf = new Float32Array(total);
      let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
      await ac.close();
      return mode === "cw"
        ? decodeMorse(morseFromTiming(cwKeyEvents(buf, sr, { pitchHz: opts.pitchHz ?? 700 })))
        : decodeVaricode(psk31Demod(buf, sr, { carrierHz: opts.carrierHz ?? 1000 }));
    },
  };
}
