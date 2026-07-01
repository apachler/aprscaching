// Compose the tour frames into a captioned teaser video — entirely in the browser.
// The Playwright-bundled ffmpeg is a minimal screencast build (no PNG decode, no drawtext/fade,
// VP8-only), so instead we drive Chromium's canvas + MediaRecorder: letterbox each frame onto a
// uniform 1920x1080 canvas, caption it with its journey label, crossfade between steps, and record
// the canvas stream to webm. No ffmpeg dependency. Output: tour/aprscaching-ui-teaser.webm
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = (process.env.OUT ?? new URL("./tour", import.meta.url).pathname).replace(/\/?$/, "/");
const EXE = process.env.PW_CHROMIUM || undefined;
const HOLD = Number(process.env.HOLD ?? 4.0) * 1000; // ms per step (incl. incoming fade) — ~3.5s of full view
const FADE = Number(process.env.FADE ?? 0.45) * 1000; // ms crossfade
const W = 1920, H = 1080;
// Static position of the viewport tag (desktop/tablet/mobile) — fixed + left-anchored, independent of
// the caption text. Move it by changing VPX (left offset) / VPY.
const VPX = Number(process.env.VPX ?? 56);
const VPY = Number(process.env.VPY ?? H - 124);

// Ordered frames (prefix 1/2/3 = desktop/tablet/mobile) + label/viewport map from the per-viewport
// manifests. Label (the step name) and viewport are kept SEPARATE so the viewport tag can be drawn at
// a fixed static position rather than trailing the variable-length caption.
const frames = fs.readdirSync(OUT).filter((f) => /^[123]-.*\.png$/.test(f)).sort();
if (!frames.length) { console.error("no frames in", OUT); process.exit(1); }
const labels = {};
for (const v of ["desktop", "tablet", "mobile"]) {
  const f = OUT + `manifest-${v}.json`;
  if (fs.existsSync(f)) for (const e of JSON.parse(fs.readFileSync(f, "utf8"))) labels[e.file] = { label: e.label, viewport: e.viewport };
}
const slides = frames.map((file) => ({
  url: "data:image/png;base64," + fs.readFileSync(OUT + file).toString("base64"),
  label: labels[file]?.label || file.replace(/\.png$/, ""),
  viewport: labels[file]?.viewport || "",
}));
console.log(`composing ${slides.length} steps -> webm (${Math.round((slides.length * HOLD) / 1000)}s)`);

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(`<!doctype html><html><body style="margin:0;background:#0b0e13">
<canvas id="c" width="${W}" height="${H}" style="display:block"></canvas></body></html>`);

const b64 = await page.evaluate(async ({ slides, W, H, HOLD, FADE, VPX, VPY }) => {
  const cv = document.getElementById("c");
  const ctx = cv.getContext("2d", { alpha: false });
  // preload images
  const imgs = await Promise.all(slides.map((s) => new Promise((res) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = () => res(im); im.src = s.url;
  })));
  // precompute letterbox rects (fit within a margin so the caption bar never overlaps content)
  const MX = 70, MTOP = 40, MBOT = 150;
  const rects = imgs.map((im) => {
    const aw = W - MX * 2, ah = H - MTOP - MBOT;
    const sc = Math.min(aw / im.naturalWidth, ah / im.naturalHeight);
    const w = im.naturalWidth * sc, h = im.naturalHeight * sc;
    return { x: (W - w) / 2, y: MTOP + (ah - h) / 2, w, h };
  });
  function drawSlide(i, alpha) {
    if (i < 0 || i >= imgs.length) return;
    ctx.globalAlpha = alpha;
    const r = rects[i];
    ctx.drawImage(imgs[i], r.x, r.y, r.w, r.h);
    // viewport tag — STATIC position (fixed, left-anchored), drawn above the caption bar
    const vp = (slides[i].viewport || "").toUpperCase();
    if (vp) {
      ctx.font = "600 24px system-ui, Arial, sans-serif";
      ctx.fillStyle = "rgba(111,208,239,0.95)";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(vp, VPX, VPY);
    }
    // caption bar (bottom-left) — the step label only (viewport is drawn separately, static)
    const label = slides[i].label;
    ctx.font = "600 40px system-ui, Arial, sans-serif";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(11,118,184,0.92)";
    const bx = 56, by = H - 112, bw = tw + 56, bh = 66;
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, bx + 28, by + bh / 2 + 1);
    ctx.globalAlpha = 1;
  }

  const stream = cv.captureStream(30);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm;codecs=vp8";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => (rec.onstop = res));
  rec.start(100);

  const N = imgs.length, total = N * HOLD;
  const t0 = performance.now();
  await new Promise((resolve) => {
    function frame() {
      const t = performance.now() - t0;
      if (t >= total) return resolve();
      ctx.fillStyle = "#0b0e13"; ctx.fillRect(0, 0, W, H);
      const idx = Math.min(N - 1, Math.floor(t / HOLD));
      const local = t - idx * HOLD;
      if (local < FADE) {
        const a = local / FADE;
        if (idx > 0) drawSlide(idx - 1, 1); else { /* fade up from black */ }
        drawSlide(idx, a);
      } else {
        drawSlide(idx, 1);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  rec.stop();
  await done;
  const blob = new Blob(chunks, { type: "video/webm" });
  const buf = await blob.arrayBuffer();
  let bin = ""; const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}, { slides, W, H, HOLD, FADE, VPX, VPY });

await browser.close();
const outFile = OUT + "aprscaching-ui-teaser.webm";
fs.writeFileSync(outFile, Buffer.from(b64, "base64"));
console.log("done:", outFile, (fs.statSync(outFile).size / 1e6).toFixed(1) + " MB");
