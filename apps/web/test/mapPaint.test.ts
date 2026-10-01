// SPDX-License-Identifier: AGPL-3.0-or-later
// whenStyleReady: a map overlay sets itself up once the style is complete — at once when it is, else at the
// first styledata or idle that finds it complete. An overlay that waited only for the one-time "load" never
// appeared when it mounted after load while another overlay's new sources kept the style "not loaded".
import { describe, expect, it } from "vitest";
import type * as maplibregl from "maplibre-gl";
import { whenStyleReady } from "../src/map/mapPaint.js";

function fakeMap(loaded: boolean) {
  const handlers = new Map<string, Set<() => void>>();
  const state = { loaded };
  const map = {
    isStyleLoaded: () => state.loaded,
    on: (ev: string, fn: () => void) => void (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(fn),
    off: (ev: string, fn: () => void) => void handlers.get(ev)?.delete(fn),
  };
  const fire = (ev: string) => [...(handlers.get(ev) ?? [])].forEach((f) => f());
  const listening = () => [...handlers.values()].reduce((n, s) => n + s.size, 0);
  return { map: map as unknown as maplibregl.Map, state, fire, listening };
}

describe("whenStyleReady", () => {
  it("sets up at once on a complete style", () => {
    const f = fakeMap(true);
    let n = 0;
    whenStyleReady(f.map, () => n++);
    expect(n).toBe(1);
    expect(f.listening()).toBe(0);
  });

  it("waits through styledata while the style is still changing, then sets up once", () => {
    const f = fakeMap(false);
    let n = 0;
    whenStyleReady(f.map, () => n++);
    f.fire("styledata");
    expect(n).toBe(0);
    f.state.loaded = true;
    f.fire("idle");
    f.fire("styledata");
    expect(n).toBe(1);
    expect(f.listening()).toBe(0);
  });

  it("does not depend on the one-time load event", () => {
    const f = fakeMap(false);
    let n = 0;
    whenStyleReady(f.map, () => n++);
    f.state.loaded = true;
    f.fire("styledata");
    expect(n).toBe(1);
  });

  it("cancels cleanly before the style is ready", () => {
    const f = fakeMap(false);
    let n = 0;
    const cancel = whenStyleReady(f.map, () => n++);
    cancel();
    f.state.loaded = true;
    f.fire("idle");
    expect(n).toBe(0);
    expect(f.listening()).toBe(0);
  });
});
