// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { addGap, backOff, dueGaps, giveUpGaps } from "@aprscaching/gateway/fedgaps";
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

describe("tombstone gaps past the hop limit", () => {
  const count = async (env: ReturnType<typeof instanceEnv>, reason: string) =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM fed_origin_gaps WHERE kind = 'tombstone' AND reason = ?")
        .bind(reason)
        .first<{ n: number }>()
    )?.n;

  it("a neighbour names are capped per origin and kind, and go after 30 days", async () => {
    const env = instanceEnv("b.example", null);
    const at = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 9999)
       INSERT INTO fed_origin_gaps (origin, kind, v, reason, first_seen) SELECT ?, 'tombstone', v, 'upstream-hops', ? FROM n`,
    )
      .bind(ORIGIN, at)
      .run();
    expect(await addGap(env, ORIGIN, "tombstone", 10_000, "upstream-hops")).toBe(true);
    expect(await addGap(env, ORIGIN, "tombstone", 10_001, "upstream-hops")).toBe(true); // past the cap: not recorded
    expect(await count(env, "upstream-hops")).toBe(10_000);
    // a tombstone gap a neighbour can fill stays: the deletion has not arrived
    await addGap(env, ORIGIN, "tombstone", 20_000, "upstream");
    const clock = vi.spyOn(Date, "now").mockReturnValue((at + 31 * 86400) * 1000);
    await giveUpGaps(env);
    clock.mockRestore();
    expect(await count(env, "upstream-hops")).toBe(0);
    expect(await count(env, "upstream")).toBe(1);
  });
});
