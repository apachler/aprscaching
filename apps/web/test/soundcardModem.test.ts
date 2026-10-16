// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  TAP_BLOCK,
  TAP_WORKLET,
  isModemReply,
  isModemStart,
  modemNote,
  openAudioRx,
  readAudioDemod,
  type AudioRx,
} from "../src/rf/soundcardModem.js";

const port = () => new MessageChannel().port1;

describe("the modem Worker's messages", () => {
  it("accepts a start with a port, a 300 or 1200 baud speed and a known modem", () => {
    const ok = { type: "start", sampleRate: 48000, baud: 1200, demod: "direwolf", samples: port() };
    expect(isModemStart(ok)).toBe(true);
    expect(isModemStart({ ...ok, baud: 300, demod: "builtin" })).toBe(true);
    for (const bad of [
      { ...ok, baud: 9600 },
      { ...ok, demod: "native" },
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
    expect(isModemReply({ type: "ready", kind: "direwolf", simd: true, fallback: null })).toBe(true);
    expect(isModemReply({ type: "ready", kind: "builtin", simd: false, fallback: "Direwolf did not load (404)" })).toBe(
      true,
    );
    expect(isModemReply({ type: "frames", frames: [{ bytes: new Uint8Array(16), fec: "il2p", corrected: 2 }] })).toBe(
      true,
    );
    expect(isModemReply({ type: "failed", message: "no" })).toBe(true);
    expect(isModemReply({ type: "ready", kind: "direwolf", simd: "yes", fallback: null })).toBe(false);
    expect(isModemReply({ type: "frames", frames: [{ bytes: [1, 2] }] })).toBe(false);
    expect(isModemReply({ type: "failed" })).toBe(false);
    expect(isModemReply(undefined)).toBe(false);
  });
});

describe("the choice of modem", () => {
  const rx = (name: string): AudioRx & { name: string } => ({ name, push: () => [] });

  it("reads the stored choice, Direwolf unless the built-in one was picked", () => {
    expect(readAudioDemod(null)).toBe("direwolf");
    expect(readAudioDemod("builtin")).toBe("builtin");
    expect(readAudioDemod("something")).toBe("direwolf");
  });

  it("runs Direwolf when it loads", async () => {
    const r = await openAudioRx("direwolf", { direwolf: async () => rx("dw"), builtin: () => rx("ts") });
    expect(r.kind).toBe("direwolf");
    expect(r.fallback).toBeNull();
    expect((r.rx as { name: string }).name).toBe("dw");
  });

  it("falls back to the built-in modem when Direwolf does not load, and says why", async () => {
    const r = await openAudioRx("direwolf", {
      direwolf: () => Promise.reject(new Error("WebAssembly: 404")),
      builtin: () => rx("ts"),
    });
    expect(r.kind).toBe("builtin");
    expect(r.fallback).toBe("Direwolf did not load (WebAssembly: 404)");
    expect(modemNote({ ...r, simd: false })).toBe("built-in modem: Direwolf did not load (WebAssembly: 404)");
  });

  it("never loads Direwolf when the built-in modem is picked", async () => {
    let tried = false;
    const r = await openAudioRx("builtin", {
      direwolf: async () => {
        tried = true;
        return rx("dw");
      },
      builtin: () => rx("ts"),
    });
    expect(tried).toBe(false);
    expect(r.kind).toBe("builtin");
    expect(modemNote({ ...r, simd: false })).toBe("built-in modem");
  });

  it("names the Direwolf build in the status", () => {
    expect(modemNote({ kind: "direwolf", simd: true, fallback: null })).toBe("Direwolf modem (SIMD)");
    expect(modemNote({ kind: "direwolf", simd: false, fallback: null })).toBe("Direwolf modem");
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
