// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDirewolfRx } from "../src/index.js";
import { fromWav, hex } from "./audio.js";

// test/make-fixture.ts writes both files: the noisy recording and the frames that went into it.
const wav = fromWav(readFileSync(new URL("./fixtures/rx-1200.wav", import.meta.url)));
const expected = readFileSync(new URL("./fixtures/rx-1200.txt", import.meta.url), "utf8")
  .trim()
  .split("\n");

describe("the receive fixture", () => {
  for (const simd of [false, true])
    it(`decodes every frame in order, ${simd ? "SIMD" : "plain"} build`, async () => {
      const rx = await createDirewolfRx({ sampleRate: wav.sampleRate, baud: 1200, simd });
      const got: string[] = [];
      // in chunks the size an audio callback delivers
      for (let i = 0; i < wav.pcm.length; i += 1024)
        for (const f of rx.push(wav.pcm.subarray(i, i + 1024))) got.push(`${f.fec} ${hex(f.bytes)}`);
      expect(got).toEqual(expected);
    });
});
