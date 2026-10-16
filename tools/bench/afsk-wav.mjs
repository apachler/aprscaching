#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * afsk-wav.mjs — run the soundcard modem APRScaching ships, Direwolf's receiver compiled to WebAssembly
 * (`modems/direwolf`, the build the ingest box and the browser load), over WAV recordings and count the frames
 * it decodes, the way Direwolf's `atest` does. A frame counts once its FCS checked (FIX_BITS 0); `unique`
 * counts distinct frame bytes, so a frame heard twice in one recording counts once there. The modem is
 * 1200-baud Bell 202 unless `--baud` names 300 or 9600; `--plain` runs the build without SIMD.
 *
 *   node tools/bench/afsk-wav.mjs track1.wav [track2.wav …] [--baud 1200] [--plain] [--json] [--frames out.txt]
 *   node tools/bench/afsk-wav.mjs --cue TNC_Test_Ver-1.1.cue [--tracks 1,2] [--json] [--frames out.txt]
 *
 * The standard recording is the WA8LMF TNC Test CD (http://wa8lmf.net/TNCtest/), published as a BIN/CUE
 * image: track 1 is traffic on 144.39 MHz from a flat discriminator, track 2 the same traffic de-emphasized
 * as a speaker output delivers it. `--cue` reads the audio tracks straight from the image (CD audio:
 * 44.1 kHz 16-bit stereo, the left channel is decoded), so no ripping is needed. A WAV may be 8- or 16-bit
 * PCM or 32-bit float, mono or stereo (the left channel is decoded). `--frames` writes each decoded frame as
 * one hex line, for a diff against another decoder's output.
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WASM_DIR = path.join(ROOT, "modems/direwolf/wasm");

/** Bundle the modem's loader from source and import it, so the benchmark runs the code the ingest ships. */
async function loadModem() {
  // a private directory: a fixed name in the shared temp dir could be pre-created by another local user
  const tmp = mkdtempSync(path.join(tmpdir(), "aprs-afsk-bench-"));
  try {
    const out = path.join(tmp, "direwolf.mjs");
    await build({
      entryPoints: [path.join(ROOT, "modems/direwolf/src/index.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: out,
      logLevel: "error",
    });
    return await import(pathToFileURL(out).href);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A RIFF/WAVE file → its sample rate and the first channel as Float32 in [-1, 1]. */
function readWav(file) {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`${file}: not a RIFF/WAVE file`);
  let fmt = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error(`${file}: data chunk before fmt chunk`);
      const end = Math.min(buf.length, body + size);
      const step = (fmt.bits / 8) * fmt.channels;
      const n = Math.floor((end - body) / step);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = body + i * step;
        if (fmt.format === 3 && fmt.bits === 32) pcm[i] = buf.readFloatLE(p);
        else if (fmt.bits === 16) pcm[i] = buf.readInt16LE(p) / 32768;
        else if (fmt.bits === 8) pcm[i] = (buf[p] - 128) / 128;
        else throw new Error(`${file}: unsupported sample format (${fmt.format}/${fmt.bits}-bit)`);
      }
      return { rate: fmt.rate, pcm };
    }
    off = body + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

/** CUE sheet "mm:ss:ff" (75 frames a second) → a sector index. */
const msf = (t) => {
  const [m, sec, f] = t.split(":").map(Number);
  return (m * 60 + sec) * 75 + f;
};

/** An audio track of a BIN/CUE image → 44.1 kHz left-channel Float32. */
function readCueTrack(cueFile, track) {
  const cue = readFileSync(cueFile, "utf8");
  const bin = path.resolve(path.dirname(cueFile), /FILE\s+"([^"]+)"/.exec(cue)[1]);
  const starts = new Map(); // track → { audio, i0, i1 }: its type and the sectors of INDEX 00 / 01
  let cur = 0;
  for (const line of cue.split(/\r?\n/)) {
    const t = /^\s*TRACK\s+(\d+)\s+(\S+)/.exec(line);
    if (t) starts.set((cur = Number(t[1])), { audio: t[2] === "AUDIO" });
    const ix = /^\s*INDEX\s+(\d+)\s+(\d+:\d+:\d+)/.exec(line);
    if (ix && cur) starts.get(cur)[ix[1] === "00" ? "i0" : "i1"] = msf(ix[2]);
  }
  const t = starts.get(track);
  if (!t?.audio || t.i1 === undefined) throw new Error(`${cueFile}: no audio track ${track}`);
  const next = starts.get(track + 1);
  const buf = readFileSync(bin);
  const SECTOR = 2352;
  const end = Math.min(buf.length, (next ? (next.i0 ?? next.i1) : buf.length / SECTOR) * SECTOR);
  const begin = t.i1 * SECTOR;
  const n = Math.floor((end - begin) / 4);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(begin + i * 4) / 32768;
  return { name: `${path.basename(cueFile)}#${track}`, rate: 44100, pcm };
}

const hex = (b) => Buffer.from(b).toString("hex");

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const framesOut = opt("--frames");
  const cue = opt("--cue");
  const tracks = (opt("--tracks") ?? "1,2").split(",").map(Number);
  const baud = Number(opt("--baud") ?? 1200);
  if (![300, 1200, 9600].includes(baud)) {
    console.error("--baud: expected 300, 1200 or 9600");
    process.exit(2);
  }
  const valued = new Set(["--frames", "--cue", "--tracks", "--baud"]);
  const files = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  const inputs = [
    ...files.map((f) => () => ({ name: path.basename(f), ...readWav(f) })),
    ...(cue ? tracks.map((t) => () => readCueTrack(cue, t)) : []),
  ];
  if (inputs.length === 0) {
    console.error(
      "usage: afsk-wav.mjs <file.wav> [more.wav …] | --cue <image.cue> [--tracks 1,2]  [--baud 1200] [--plain] [--json] [--frames out.txt]",
    );
    process.exit(2);
  }
  const { createDirewolfRx, direwolfHasSimd } = await loadModem();
  const simd = !args.includes("--plain") && direwolfHasSimd();
  const wasm = await WebAssembly.compile(
    readFileSync(path.join(WASM_DIR, simd ? "direwolf-simd.wasm" : "direwolf.wasm")),
  );
  if (!json) console.log(`Direwolf ${baud} baud${simd ? " (SIMD)" : ""}`);
  const results = [];
  const lines = [];
  for (const load of inputs) {
    const { name, rate, pcm } = load();
    const frames = [];
    const rx = await createDirewolfRx({ sampleRate: rate, baud, wasm });
    const chunk = 4096;
    const t0 = performance.now();
    for (let i = 0; i < pcm.length; i += chunk)
      for (const f of rx.push(pcm.subarray(i, i + chunk))) frames.push(hex(f.bytes));
    const seconds = (performance.now() - t0) / 1000;
    const audio = pcm.length / rate;
    const r = {
      file: name,
      rate,
      baud,
      simd,
      audioSeconds: +audio.toFixed(1),
      frames: frames.length,
      unique: new Set(frames).size,
      decodeSeconds: +seconds.toFixed(2),
      realtime: +(audio / seconds).toFixed(1),
    };
    results.push(r);
    for (const f of frames) lines.push(`${r.file} ${f}`);
    if (!json)
      console.log(
        `${r.file}: ${r.frames} frames (${r.unique} unique), ${r.audioSeconds} s of audio at ${rate} Hz ` +
          `decoded in ${r.decodeSeconds} s (${r.realtime}x real time)`,
      );
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  if (framesOut) writeFileSync(framesOut, lines.join("\n") + "\n");
}

await main();
