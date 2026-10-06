// SPDX-License-Identifier: AGPL-3.0-or-later
// The live WebSocket joins only the region this instance dispatches to; any other name is refused before a
// room is opened for it.
import { describe, it, expect } from "vitest";
import { route } from "../src/app.js";
import { liveRegionOf, LIVE_REGION } from "../src/live.js";
import type { Env } from "../src/env.js";
import type { ExecCtx } from "../src/runtime.js";

describe("the live region", () => {
  it("is the instance's one region, whether named or absent", () => {
    expect(liveRegionOf(new URL("http://gw/ws"))).toBe(LIVE_REGION);
    expect(liveRegionOf(new URL(`http://gw/ws?region=${LIVE_REGION}`))).toBe(LIVE_REGION);
    expect(liveRegionOf(new URL("http://gw/ws?region=eu"))).toBeNull();
    expect(liveRegionOf(new URL("http://gw/ws?region="))).toBeNull();
  });

  it("answers 400 for any other region without opening a room", async () => {
    const opened: string[] = [];
    const env = {
      ROOMS: {
        get: (n: string) => (opened.push(n), { fetch: async () => new Response(null, { status: 204 }) }),
      },
    } as unknown as Env;
    const ws = (q: string) => route(new Request(`http://gw/ws${q}`), env, {} as ExecCtx);
    expect((await ws("?region=x1")).status).toBe(400);
    expect(opened).toEqual([]);
    expect((await ws("?region=global")).status).toBe(204);
    expect(opened).toEqual(["global"]);
  });
});
