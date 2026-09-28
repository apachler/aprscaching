// SPDX-License-Identifier: AGPL-3.0-or-later
// Convert the UI-tour frames the manual uses into compact WebP under docs/assets/shots/.
// Input: FRAMES (the tour output dir, frames named `<n>-<seq>-<viewport>-<step>.png`).
// Output: DEST/<step>-<viewport>.webp. Encoding runs in Chromium (canvas.toBlob), so no image
// library is needed. Exits non-zero when a frame the manual references is missing.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const FRAMES = process.env.FRAMES ?? new URL("./tour", import.meta.url).pathname;
const DEST = process.env.DEST ?? new URL("../../docs/assets/shots", import.meta.url).pathname;
const EXE = process.env.PW_CHROMIUM || undefined;
const QUALITY = 0.8;
// Width the manual shows images at; larger frames are scaled down to keep the repo small.
const MAX_W = { desktop: 1280, mobile: 390 };

/**
 * The frames the guides embed: [tour step, viewports]. The tour runs signed out, so only screens that look
 * the same signed out are used — its "logfind" and "hide" frames show the sign-in prompt instead.
 */
const WANTED = [
  ["signin", ["mobile", "desktop"]],
  ["map", ["mobile", "desktop"]],
  ["filter", ["desktop"]],
  ["detail", ["mobile", "desktop"]],
  ["shack-launcher", ["desktop"]],
  ["rig", ["desktop"]],
  ["set-account", ["desktop"]],
];

const files = fs.readdirSync(FRAMES).filter((f) => f.endsWith(".png"));
const find = (step, view) => files.find((f) => new RegExp(`^\\d-\\d+-${view}-${step}\\.png$`).test(f));

fs.mkdirSync(DEST, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setContent("<canvas></canvas>");

const missing = [];
for (const [step, views] of WANTED) {
  for (const view of views) {
    const file = find(step, view);
    if (!file) {
      missing.push(`${view}/${step}`);
      continue;
    }
    const b64 = fs.readFileSync(path.join(FRAMES, file)).toString("base64");
    const webp = await page.evaluate(
      async ([data, maxW, q]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const scale = Math.min(1, maxW / img.naturalWidth);
        const c = document.querySelector("canvas");
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise((r) => c.toBlob(r, "image/webp", q));
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = "";
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      },
      [b64, MAX_W[view], QUALITY],
    );
    const out = path.join(DEST, `${step}-${view}.webp`);
    fs.writeFileSync(out, Buffer.from(webp, "base64"));
    console.log(`  ✓ ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  }
}
await browser.close();
if (missing.length) {
  console.error(`✗ missing tour frames: ${missing.join(", ")}`);
  process.exit(1);
}
