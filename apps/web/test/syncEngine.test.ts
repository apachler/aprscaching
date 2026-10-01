// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  AUTO_REFRESH_AFTER_MS,
  autoRefreshAllowed,
  oldestPack,
  packsToRefresh,
  statusLine,
  unmetered,
} from "../src/offline/syncEngine.js";
import type { PackMeta } from "../src/offline/store.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const pack = (id: string, age: number, extra: Partial<PackMeta> = {}): PackMeta => ({
  id,
  name: id,
  area: { locator: "JN77" },
  filters: { types: [] },
  images: "none",
  instance: "x",
  createdAt: 0,
  refreshedAt: NOW - age,
  generation: "g",
  cacheCount: 1,
  sizeBytes: 1,
  ...extra,
});

describe("when packs refresh on their own", () => {
  it("reads the connection type, and a data saver as metered", () => {
    expect(unmetered({ type: "wifi" })).toBe(true);
    expect(unmetered({ type: "ethernet" })).toBe(true);
    expect(unmetered({ type: "cellular" })).toBe(false);
    expect(unmetered({ type: "wifi", saveData: true })).toBe(false);
    expect(unmetered({ type: "unknown" })).toBeNull();
    expect(unmetered(null)).toBeNull();
  });
  it("only on an unmetered connection, unless mobile data is allowed", () => {
    expect(autoRefreshAllowed(true, false)).toBe(true);
    expect(autoRefreshAllowed(false, false)).toBe(false);
    expect(autoRefreshAllowed(null, false)).toBe(false); // a browser that does not say: no automatic refresh
    expect(autoRefreshAllowed(false, true)).toBe(true);
  });
  it("picks the aged packs not backing off; Sync now picks every pack of the user's", () => {
    const packs = [
      pack("fresh", AUTO_REFRESH_AFTER_MS / 2),
      pack("aged", 2 * DAY),
      pack("waiting", 2 * DAY),
      pack("auto", 3 * DAY, { auto: true, area: null }),
    ];
    const backoffUntil = new Map([["waiting", NOW + 60_000]]);
    expect(packsToRefresh(packs, NOW, { manual: false, backoffUntil }).map((p) => p.id)).toEqual(["aged"]);
    expect(packsToRefresh(packs, NOW, { manual: true, backoffUntil }).map((p) => p.id)).toEqual([
      "fresh",
      "aged",
      "waiting",
    ]);
  });
});

describe("the status line", () => {
  it("says what waits and how old the oldest pack is", () => {
    expect(
      statusLine({ queued: 3, elsewhere: 0, attention: 1, oldestPack: { name: "JN77sb", ageMs: 2 * DAY + 5 } }),
    ).toBe("3 logs waiting · 1 needs attention · pack “JN77sb” 2 days old");
    expect(statusLine({ queued: 1, elsewhere: 2, attention: 2, oldestPack: null })).toBe(
      "1 log waiting · 2 for another instance · 2 need attention",
    );
    expect(statusLine({ queued: 0, elsewhere: 0, attention: 0, oldestPack: null })).toBe("");
  });
  it("mentions the oldest of the user's packs only once it is a day old", () => {
    expect(oldestPack([pack("a", DAY / 2)], NOW)).toBeNull();
    expect(oldestPack([pack("a", 2 * DAY), pack("b", 5 * DAY), pack("c", 9 * DAY, { auto: true })], NOW)).toEqual({
      name: "b",
      ageMs: 5 * DAY,
    });
  });
});
