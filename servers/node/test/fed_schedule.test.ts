// SPDX-License-Identifier: AGPL-3.0-or-later
// The frequent federation sync runs on FED_SYNC_INTERVAL_MS whatever the configuration names: a peer the sysop
// added in Instance admin exists only as a row, and is pulled on the same schedule as a FED_PEERS entry. Node
// and Bun (and the desktop launcher, which wraps the Bun server) share startSchedules.
import { describe, it, expect, afterEach, vi } from "vitest";
import { startSchedules } from "../src/host.js";
import { addCache, instanceEnv, newFedKey, serve, stubFetch } from "./helpers/fedpeer.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the frequent federation sync", () => {
  it("pulls a peer added in Instance admin on the interval, with no FED_PEERS or hub", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key);
    await addCache(a, 1000);
    let pulls = 0;
    const peer = serve(a);
    stubFetch({
      "https://a.example": (req) => {
        if (new URL(req.url).pathname === "/.well-known/aprscaching") pulls++;
        return peer(req);
      },
    });
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES ('https://a.example', 'a.example', ?, ?, 'unvetted', 'admin')",
    )
      .bind(key.pub, JSON.stringify([{ x: key.pub }]))
      .run();

    vi.useFakeTimers({ toFake: ["setInterval"] }); // the intervals run when told; everything else is real
    startSchedules(hub, 60_000);
    const settle = async () => {
      for (let i = 0; i < 50 && (await vi.waitFor(() => true)) && i < 50; i++)
        await new Promise((r) => setTimeout(r, 5));
    };
    await settle();
    const atStart = pulls;
    expect(atStart).toBeGreaterThanOrEqual(1);
    for (let i = 1; i <= 3; i++) {
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(pulls).toBe(atStart + i);
    }
  });
});
