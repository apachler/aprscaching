// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  TAP_BLOCK,
  TAP_WORKLET,
  isModemReply,
  isModemStart,
  modemFailure,
  modemNote,
} from "../src/rf/soundcardModem.js";

const port = () => new MessageChannel().port1;

describe("the modem Worker's messages", () => {
  it("accepts a start with a port and a 300 or 1200 baud speed", () => {
    const ok = { type: "start", sampleRate: 48000, baud: 1200, samples: port() };
    expect(isModemStart(ok)).toBe(true);
    expect(isModemStart({ ...ok, baud: 300 })).toBe(true);
    for (const bad of [
      { ...ok, baud: 9600 },
      { ...ok, sampleRate: 4000 },
      { ...ok, sampleRate: 44100.5 },
      { ...ok, samples: undefined },
      { ...ok, type: "stop" },
      null,
      "start",
    ])
      expect(isModemStart(bad)).toBe(false);
  });

  it("accepts the replies the Worker sends and nothing else", () => {
    expect(isModemReply({ type: "ready", simd: true })).toBe(true);
    expect(isModemReply({ type: "frames", frames: [{ bytes: new Uint8Array(16), fec: "il2p", corrected: 2 }] })).toBe(
      true,
    );
    expect(isModemReply({ type: "failed", message: "404", load: true })).toBe(true);
    expect(isModemReply({ type: "failed", message: "no", load: false })).toBe(true);
    expect(isModemReply({ type: "ready", simd: "yes" })).toBe(false);
    expect(isModemReply({ type: "frames", frames: [{ bytes: [1, 2] }] })).toBe(false);
    expect(isModemReply({ type: "failed", message: "no" })).toBe(false);
    expect(isModemReply({ type: "failed" })).toBe(false);
    expect(isModemReply(undefined)).toBe(false);
  });
});

describe("the modem's status and errors", () => {
  it("names the Direwolf build in the status", () => {
    expect(modemNote({ simd: true })).toBe("Direwolf modem (SIMD)");
    expect(modemNote({ simd: false })).toBe("Direwolf modem");
  });

  it("explains a modem that could not load: cache it online once, or allow WebAssembly", () => {
    const text = modemFailure({ message: "WebAssembly: 404", load: true });
    expect(text).toMatch(/^the soundcard modem could not load \(WebAssembly: 404\)\./);
    expect(text).toMatch(/once while online/);
    expect(text).toMatch(/allow WebAssembly for this site/);
  });

  it("passes any other failure on in the Worker's words", () => {
    expect(modemFailure({ message: "bad start", load: false })).toBe("the soundcard modem did not start: bad start");
  });
});

interface TapProcessor {
  port: { onmessage: (e: { data: unknown }) => void };
  process(inputs: Float32Array[][]): boolean;
}

describe("the worklet tap", () => {
  it("posts whole blocks of samples to the port it is handed", () => {
    const posted: Float32Array[] = [];
    let Proc: (new () => TapProcessor) | null = null;
    class AudioWorkletProcessor {
      port = { onmessage: (_e: { data: unknown }) => {} };
    }
    new Function("AudioWorkletProcessor", "registerProcessor", TAP_WORKLET)(
      AudioWorkletProcessor,
      (_name: string, c: new () => TapProcessor) => (Proc = c),
    );
    const p = new Proc!();
    const quantum = new Float32Array(128).fill(0.5);
    p.process([[quantum]]); // dropped: no port yet
    p.port.onmessage({ data: { postMessage: (b: Float32Array) => posted.push(b) } });
    for (let i = 0; i < TAP_BLOCK / 128 + 1; i++) expect(p.process([[quantum]])).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.length).toBe(TAP_BLOCK);
    expect(posted[0]![0]).toBe(0.5);
  });
});
