// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlapping map refreshes: only the newest run writes, so a slow answer for the viewport the map left never
// replaces the markers of the one it shows; and a failing refresh says so once, not on every pan.
import { describe, expect, it } from "vitest";
import { latestOnly, onceEvery } from "../src/ui/latest.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("latestOnly", () => {
  it("lets the newest run write when an older one answers last", async () => {
    const start = latestOnly();
    let shown = "";
    const run = async (answer: Promise<string>) => {
      const current = start();
      const v = await answer;
      if (current()) shown = v;
    };
    const townA = deferred<string>();
    const townB = deferred<string>();
    const a = run(townA.promise);
    const b = run(townB.promise);
    townB.resolve("caches of B");
    await b;
    townA.resolve("caches of A");
    await a;
    expect(shown).toBe("caches of B");
  });

  it("keeps each guard independent", () => {
    const one = latestOnly();
    const two = latestOnly();
    const a = one();
    two();
    expect(a()).toBe(true);
    one();
    expect(a()).toBe(false);
  });
});

describe("onceEvery", () => {
  it("lets one call through per window", () => {
    let t = 0;
    const gate = onceEvery(30_000, () => t);
    expect(gate()).toBe(true);
    t = 10_000;
    expect(gate()).toBe(false);
    t = 30_000;
    expect(gate()).toBe(true);
    t = 30_001;
    expect(gate()).toBe(false);
  });
});
