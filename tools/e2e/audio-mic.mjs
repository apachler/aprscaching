/**
 * audio-mic.mjs — a headless Chromium end-to-end test for the LIVE mic decode path (docs/28 §6). It closes
 * the "validate-at-deploy" gap on `apps/web/src/rf/audioDecode.ts`: the pure DSP is unit-tested, but the
 * browser plumbing (getUserMedia -> AudioContext -> AudioWorklet tap -> StreamDecoder) only exists in a real
 * engine. This drives that exact code in Chromium, fed by a SYNTHESISED PSK31 signal through Chromium's
 * fake-audio-capture device, and asserts the decoded text.
 *
 *   1. esbuild-bundle the real `audioDecode.ts` (from source) -> window.AudioDecode.
 *   2. Synthesise a BPSK PSK31 WAV of "cq de test" and hand it to Chromium as the fake microphone.
 *   3. Launch Chromium with the fake device, call the real `listenDecode('psk31', ...)`, wait, stop.
 *   4. Assert the decoded text contains the message.
 *
 * Portable + safe to run anywhere: if no Chromium is found it prints SKIP and exits 0 (so Node-only CI is
 * never broken); the dedicated `conformance-audio` CI job installs a browser so the real assertion runs.
 * Browser resolution: $CHROMIUM_PATH, then /opt/pw-browsers/chromium-*, then playwright-core's registry.
 */
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { createServer } from "node:http";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SR = 8000, BAUD = 31.25, MESSAGE = "cq de test";

// ---- minimal PSK31 varicode (only the chars this test needs) + BPSK synthesiser -----------------------
const VC = { " ": "1", c: "101111", q: "110111111", d: "101101", e: "11", t: "101", s: "10111" };
const enc = (text) => "00" + [...text].map((ch) => VC[ch]).join("00") + "00";
function synthWav(bits, carrierHz) {
  const sps = SR / BAUD; const s = [];   // NB: sps=256 here, so total samples stay a multiple of the symbol
  let phase = 0;                          // period — every looped copy of the file keeps the same timing offset.
  const emit = (ph) => { const start = s.length; for (let i = 0; i < sps; i++) s.push(Math.cos((2 * Math.PI * carrierHz * (start + i)) / SR + ph)); };
  emit(phase);
  for (const b of bits) { if (b === "0") phase += Math.PI; emit(phase); }
  const pcm = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s[i] * 28000))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
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
  } catch { /* no such dir */ }
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch { /* not installed */ }
  return null;
}

async function main() {
  const exe = findChromium();
  if (!exe) { console.log("SKIP: no Chromium available (set CHROMIUM_PATH or `npx playwright install chromium`)"); process.exit(0); }

  // 1. bundle the REAL audioDecode.ts from source -> window.AudioDecode
  const bundled = await build({
    entryPoints: [path.join(ROOT, "apps/web/src/rf/audioDecode.ts")],
    bundle: true, format: "iife", globalName: "AudioDecode", write: false, platform: "browser", target: "es2022",
  });
  const bundleJs = bundled.outputFiles[0].text;

  // 2. synth WAV (repeat the message so the looping fake device always has a clean copy in the capture window)
  const wavPath = path.join(tmpdir(), "aprs-psk31-e2e.wav");
  const bits = "0".repeat(16) + enc(MESSAGE) + "0".repeat(16);   // idle padding round the message
  writeFileSync(wavPath, synthWav(bits, 1006));   // deliberately +6 Hz off-tune, to exercise carrier recovery

  const HTML = `<!doctype html><meta charset=utf-8><title>audio-e2e</title><script src="/bundle.js"></script>`;
  const srv = createServer((req, res) => {
    if (req.url === "/bundle.js") { res.setHeader("content-type", "application/javascript"); res.end(bundleJs); }
    else { res.setHeader("content-type", "text/html"); res.end(HTML); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const browser = await chromium.launch({
    executablePath: exe, headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",                        // auto-accept the mic permission prompt
      "--use-file-for-fake-audio-capture=" + wavPath,          // feed our synthesised PSK31 as the "mic"
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
    ],
  });
  let decoded = "";
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text()); });
    await page.goto(`http://127.0.0.1:${port}/`);
    const supported = await page.evaluate(() => !!window.AudioDecode?.audioDecodeSupported?.());
    if (!supported) throw new Error("audioDecodeSupported() was false in Chromium");
    await page.evaluate(async () => {
      window.__cap = await window.AudioDecode.listenDecode("psk31", { carrierHz: 1000, baud: 31.25, sampleRate: 8000, onText: (t) => (window.__live = t) });
    });
    await page.waitForTimeout(7500);                           // > 2 loops of the ~3s file → a whole clean copy
    // is always fully captured regardless of where playback started (the file loops on the fake device).
    decoded = await page.evaluate(async () => await window.__cap.stop());
  } finally {
    await browser.close(); srv.close();
  }

  console.log(`decoded: ${JSON.stringify(decoded)}`);
  if (!decoded.includes(MESSAGE)) {
    console.error(`FAIL: expected decoded text to contain ${JSON.stringify(MESSAGE)}`);
    process.exit(1);
  }
  console.log(`PASS: live mic path decoded ${JSON.stringify(MESSAGE)} through Chromium fake-audio capture`);
}

main().catch((e) => { console.error(e); process.exit(1); });
