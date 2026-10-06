// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { addGap, backOff, dueGaps } from "@aprscaching/gateway/fedgaps";
import { instanceEnv } from "./helpers/fedpeer.js";

const ORIGIN = "a.example";

describe("dueGaps", () => {
  it("finds the gaps due for a neighbour past any number it is not due to be asked about", async () => {
    const env = instanceEnv("b.example", null);
    for (let v = 1; v <= 600; v++) await addGap(env, ORIGIN, "cache", v, "unsettled");
    // h1 was asked about the first 550 and is not due again yet
    for (let v = 1; v <= 550; v++) await backOff(env, ORIGIN, "cache", v, "h1.example");
    expect(await dueGaps(env, ORIGIN, "cache", "h1.example", 3)).toEqual([551, 552, 553]);
    // a neighbour never asked is due for every gap, lowest first
    expect(await dueGaps(env, ORIGIN, "cache", "h2.example", 3)).toEqual([1, 2, 3]);
  });

  it("asks the gaps a neighbour can fill before those past the hop limit", async () => {
    const env = instanceEnv("b.example", null);
    await addGap(env, ORIGIN, "find", 1, "hops");
    await addGap(env, ORIGIN, "find", 2, "unsettled");
    await addGap(env, ORIGIN, "find", 3, "upstream");
    expect(await dueGaps(env, ORIGIN, "find", "h1.example", 10)).toEqual([2, 3, 1]);
    expect(await dueGaps(env, ORIGIN, "find", "h1.example", 0)).toEqual([]);
  });
});
