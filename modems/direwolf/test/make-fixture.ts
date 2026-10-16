// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes the receive fixture: test/fixtures/rx-1200.wav and the frame list it holds, rx-1200.txt.
//
//   pnpm --filter @aprscaching/direwolf fixture
//
// 20 AX.25 frames from the MIT modulator in @aprscaching/aprs, then two FX.25 and two IL2P frames from this
// package's transmitter, at 11025 Hz with seeded noise over the whole file. The list is what was sent, one
// `<fec> <hex>` line per frame, so the receive test checks the decoder against the input, not against itself.
import { writeFileSync } from "node:fs";
import { modulateAfsk } from "@aprscaching/aprs";
import { createDirewolfTx } from "../src/index.js";
import { addNoise, concat, hex, testFrame, toWav } from "./audio.js";

const RATE = 11025;
const dir = new URL("./fixtures/", import.meta.url);
const parts: Int16Array[] = [];
const lines: string[] = [];
const gap = new Int16Array(Math.round(RATE / 20));

for (let i = 0; i < 20; i++) {
  const f = testFrame(i, "afsk");
  const pcm = modulateAfsk(f, RATE, { flags: 24, amplitude: 0.5 });
  parts.push(
    Int16Array.from(pcm, (s) => Math.round(s * 32767)),
    gap,
  );
  lines.push(`none ${hex(f)}`);
}
for (const mode of ["fx25", "il2p"] as const) {
  const tx = await createDirewolfTx({ sampleRate: RATE, baud: 1200, mode, txdelayMs: 150, txtailMs: 20 });
  for (let i = 0; i < 2; i++) {
    const f = testFrame(20 + i, mode);
    parts.push(tx.modulate(f), gap);
    lines.push(`${mode} ${hex(f)}`);
  }
}
const audio = addNoise(concat(parts), 1500, 1200);
writeFileSync(new URL("rx-1200.wav", dir), toWav(audio, RATE));
writeFileSync(new URL("rx-1200.txt", dir), lines.join("\n") + "\n");
console.log("rx-1200.wav: %d frames, %s s", lines.length, (audio.length / RATE).toFixed(1));
