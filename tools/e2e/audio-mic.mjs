// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * audio-mic.mjs — a headless Chromium end-to-end test for the LIVE mic decode paths. The pure DSP is
 * unit-tested, but the browser plumbing only exists in a real engine. This drives the real code in Chromium,
 * fed by synthesised audio through Chromium's fake-audio-capture device, and asserts what it decodes.
 *
 * PSK31 (`apps/web/src/rf/audioDecode.ts`: getUserMedia -> AudioContext -> AudioWorklet tap -> StreamDecoder):
 *   1. esbuild-bundle the real `audioDecode.ts` (from source) -> window.AudioDecode.
 *   2. Synthesise a BPSK PSK31 WAV of "cq de test" and hand it to Chromium as the fake microphone.
 *   3. Call the real `listenDecode('psk31', ...)`, wait, stop, and assert the decoded text contains the message.
 *
 * The soundcard link (`apps/web/src/rf/soundcard.ts`: getUserMedia -> AudioWorklet tap -> modem Worker running
 * Direwolf's WebAssembly -> AX.25 frames):
 *   1. esbuild-bundle the real `soundcard.ts` and `soundcard.worker.ts`; the Worker fetches the committed
 *      `.wasm` files of `modems/direwolf` from this test's server.
 *   2. Modulate two 1200-baud frames with Direwolf's transmitter, one plain AX.25 and one IL2P, into the fake
 *      microphone's WAV.
 *   3. Connect the real `SoundcardLink`: it must report the Direwolf modem and hear both frames (only Direwolf
 *      decodes IL2P).
 *   4. Connect it again with the server answering 404 for the WebAssembly: it must fall back to the built-in
 *      modem, say so in its note, and still hear the plain frame.
 *
 * Portable + safe to run anywhere: if no Chromium is found it prints SKIP and exits 0, and fails in CI (`CI`
 * set), where the `e2e-audio` job installs the browser playwright-core expects so the real assertion runs.
 * Browser resolution: $CHROMIUM_PATH, then /opt/pw-browsers/chromium-*, then playwright-core's registry.
 */
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SR = 8000,
  BAUD = 31.25,
  MESSAGE = "cq de test";

// ---- minimal PSK31 varicode (only the chars this test needs) + BPSK synthesiser -----------------------
const VC = { " ": "1", c: "101111", q: "110111111", d: "101101", e: "11", t: "101", s: "10111" };
const enc = (text) => "00" + [...text].map((ch) => VC[ch]).join("00") + "00";
function synthWav(bits, carrierHz) {
  const sps = SR / BAUD;
  const s = []; // NB: sps=256 here, so total samples stay a multiple of the symbol
  let phase = 0; // period — every looped copy of the file keeps the same timing offset.
  const emit = (ph) => {
    const start = s.length;
    for (let i = 0; i < sps; i++) s.push(Math.cos((2 * Math.PI * carrierHz * (start + i)) / SR + ph));
  };
  emit(phase);
  for (const b of bits) {
    if (b === "0") phase += Math.PI;
    emit(phase);
  }
  const pcm = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++)
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s[i] * 28000))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try {
    for (const d of readdirSync("/opt/pw-browsers")) {
      if (!d.startsWith("chromium-")) continue;
      const p = `/opt/pw-browsers/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  } catch {
    /* no such dir */
  }
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return null;
}

/** A 16-bit mono WAV of `pcm` (an Int16Array) at `rate`. */
function wav16(pcm, rate) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const WASM_DIR = path.join(ROOT, "modems/direwolf/wasm");
const AFSK_RATE = 48000;
const PLAIN_TEXT = ">plain AX.25 heard";
const IL2P_TEXT = ">IL2P heard";

/** Two 1200-baud frames from Direwolf's transmitter, plain AX.25 and IL2P, with silence round each. */
async function synthAfsk(tmp) {
  const gen = path.join(tmp, "gen.mjs");
  await build({
    stdin: {
      contents: `
        import { createDirewolfTx } from "@aprscaching/direwolf";
        import { encodeAx25 } from "@aprscaching/aprs";
        export async function frames(wasm, sampleRate, texts) {
          const out = [];
          for (const [mode, payload] of texts) {
            const tx = await createDirewolfTx({ sampleRate, baud: 1200, mode, txdelayMs: 300, txtailMs: 50, wasm });
            out.push(tx.modulate(encodeAx25({ src: "OE8APR-1", dst: "APZACG", path: ["WIDE1-1"], payload })));
          }
          return out;
        }`,
      resolveDir: path.join(ROOT, "apps/web"),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: gen,
    logLevel: "error",
  });
  const { frames } = await import(pathToFileURL(gen).href);
  const wasm = readFileSync(path.join(WASM_DIR, "direwolf.wasm"));
  const parts = await frames(wasm, AFSK_RATE, [
    ["ax25", PLAIN_TEXT],
    ["il2p", IL2P_TEXT],
  ]);
  const gap = new Int16Array(AFSK_RATE / 2);
  const seq = [gap, parts[0], gap, parts[1], gap];
  const pcm = new Int16Array(seq.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of seq) {
    pcm.set(p, at);
    at += p.length;
  }
  return wav16(pcm, AFSK_RATE);
}

/** Serve the test page, its bundles and the Direwolf WebAssembly (or a 404 for it while `state.failWasm`). */
function serve(files, state) {
  const HTML = `<!doctype html><meta charset=utf-8><title>audio-e2e</title><script type=module src="/page.js"></script>`;
  const srv = createServer((req, res) => {
    const url = new URL(req.url, "http://x").pathname;
    if (url.startsWith("/wasm/")) {
      const name = path.basename(url);
      if (state.failWasm || !/^direwolf(-simd)?\.wasm$/.test(name)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      state.wasmFetched.push(name);
      res.setHeader("content-type", "application/wasm");
      res.end(readFileSync(path.join(WASM_DIR, name)));
    } else if (files[url]) {
      res.setHeader("content-type", "application/javascript");
      res.end(files[url]);
    } else {
      res.setHeader("content-type", "text/html");
      res.end(HTML);
    }
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

/** Launch Chromium with `wavPath` as the microphone and run `fn(page)` on the test page. */
async function withBrowser(exe, port, wavPath, fn) {
  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream", // auto-accept the mic permission prompt
      "--use-file-for-fake-audio-capture=" + wavPath, // feed the synthesised signal as the "mic"
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      // Chromium's output on a fake, timer-clocked sink, never the host's sound server: a desktop
      // PipeWire/Pulse server clocks the AudioContext out of step with the fake mic and garbles the decode.
      "--disable-audio-output",
    ],
    // No reachable Pulse server either, so the host's sound server has no part in the run.
    env: { ...process.env, PULSE_SERVER: "unix:/nonexistent" },
  });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.log("  [page error]", m.text());
    });
    page.on("pageerror", (e) => console.log("  [page error]", e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => !!window.AudioDecode && !!window.SoundcardLink);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** Connect the real soundcard link for a few loops of the fake microphone; its note and the payloads it heard. */
const listenSoundcard = (page) =>
  page.evaluate(async () => {
    const heard = [];
    const link = new window.SoundcardLink((f) => heard.push(f.frame.payload), undefined, {
      baud: 1200,
      demod: "direwolf",
      makeWorker: () => new Worker("/modem-worker.js", { type: "module" }),
    });
    await link.connect();
    await new Promise((r) => setTimeout(r, 7000)); // > 2 loops of the ~2.5 s file
    await link.disconnect();
    return { note: link.note, heard };
  });

/** Resolve the Worker's `?url` imports of the WebAssembly to this test server's /wasm/ path. */
const wasmUrls = {
  name: "wasm-url",
  setup(b) {
    b.onResolve({ filter: /\.wasm\?url$/ }, (a) => ({
      path: path.basename(a.path.replace(/\?url$/, "")),
      namespace: "wasm-url",
    }));
    b.onLoad({ filter: /.*/, namespace: "wasm-url" }, (a) => ({
      contents: `export default ${JSON.stringify(`/wasm/${a.path}`)};`,
      loader: "js",
    }));
  },
};

async function main() {
  const exe = findChromium();
  if (!exe) {
    if (process.env.CI)
      throw new Error("no Chromium in CI: install it with pnpm exec playwright-core install --with-deps chromium");
    console.log("SKIP: no Chromium available (set CHROMIUM_PATH or `pnpm exec playwright-core install chromium`)");
    process.exit(0);
  }

  // A private, unpredictable directory: a fixed name in the shared temp dir could be pre-created or
  // symlinked by another local user.
  const tmp = mkdtempSync(path.join(tmpdir(), "aprs-audio-e2e-"));
  const state = { failWasm: false, wasmFetched: [] };
  let srv;
  let failed = false;
  try {
    // 1. bundle the REAL page code from source (audioDecode.ts, soundcard.ts) and the modem Worker
    const common = { bundle: true, format: "esm", write: false, platform: "browser", target: "es2022" };
    const page = await build({
      ...common,
      stdin: {
        contents: `
          import * as AudioDecode from "./src/rf/audioDecode.ts";
          import { SoundcardLink } from "./src/rf/soundcard.ts";
          window.AudioDecode = AudioDecode;
          window.SoundcardLink = SoundcardLink;`,
        resolveDir: path.join(ROOT, "apps/web"),
        loader: "ts",
      },
    });
    const worker = await build({
      ...common,
      entryPoints: [path.join(ROOT, "apps/web/src/rf/soundcard.worker.ts")],
      plugins: [wasmUrls],
    });
    srv = await serve({ "/page.js": page.outputFiles[0].text, "/modem-worker.js": worker.outputFiles[0].text }, state);
    const port = srv.address().port;

    // 2. PSK31: repeat the message so the looping fake device always has a clean copy in the capture window
    const pskWav = path.join(tmp, "psk31.wav");
    const bits = "0".repeat(16) + enc(MESSAGE) + "0".repeat(16); // idle padding round the message
    writeFileSync(pskWav, synthWav(bits, 1006)); // deliberately +6 Hz off-tune, to exercise carrier recovery
    const decoded = await withBrowser(exe, port, pskWav, async (p) => {
      const supported = await p.evaluate(() => !!window.AudioDecode?.audioDecodeSupported?.());
      if (!supported) throw new Error("audioDecodeSupported() was false in Chromium");
      await p.evaluate(async () => {
        window.__cap = await window.AudioDecode.listenDecode("psk31", {
          carrierHz: 1000,
          baud: 31.25,
          sampleRate: 8000,
          onText: (t) => (window.__live = t),
        });
      });
      await p.waitForTimeout(7500); // > 2 loops of the ~3s file → a whole clean copy
      // is always fully captured regardless of where playback started (the file loops on the fake device).
      return await p.evaluate(async () => await window.__cap.stop());
    });
    console.log(`psk31 decoded: ${JSON.stringify(decoded)}`);
    if (!decoded.includes(MESSAGE)) {
      console.error(`FAIL: expected decoded text to contain ${JSON.stringify(MESSAGE)}`);
      failed = true;
    } else console.log(`PASS: live mic path decoded ${JSON.stringify(MESSAGE)} through Chromium fake-audio capture`);

    // 3. the soundcard link on Direwolf: both frames, IL2P included
    const afskWav = path.join(tmp, "afsk.wav");
    writeFileSync(afskWav, await synthAfsk(tmp));
    const dw = await withBrowser(exe, port, afskWav, listenSoundcard);
    console.log(`soundcard (Direwolf): ${JSON.stringify(dw)}, fetched ${JSON.stringify(state.wasmFetched)}`);
    if (
      !dw.note.startsWith("Direwolf modem") ||
      !state.wasmFetched.length ||
      !dw.heard.includes(PLAIN_TEXT) ||
      !dw.heard.includes(IL2P_TEXT)
    ) {
      console.error("FAIL: the Direwolf modem should run and hear both the plain AX.25 and the IL2P frame");
      failed = true;
    } else console.log("PASS: the soundcard link decoded AX.25 and IL2P with Direwolf in a Worker");

    // 4. the WebAssembly missing: the built-in modem, which hears the plain frame only
    state.failWasm = true;
    const ts = await withBrowser(exe, port, afskWav, listenSoundcard);
    console.log(`soundcard (no WebAssembly): ${JSON.stringify(ts)}`);
    if (
      !ts.note.startsWith("built-in modem: Direwolf did not load") ||
      !ts.heard.includes(PLAIN_TEXT) ||
      ts.heard.includes(IL2P_TEXT)
    ) {
      console.error("FAIL: without the WebAssembly the built-in modem should run, say so and hear the plain frame");
      failed = true;
    } else console.log("PASS: without the WebAssembly the soundcard link fell back to the built-in modem");
  } finally {
    srv?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
