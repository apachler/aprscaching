// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// A style swap (Phosphor, or the offline pack style) wipes every style layer. The track replay adds its line,
// points and playhead back on the next style epoch, with the track that was loaded, so it does not go blank.
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api.js", async (orig) => ({
  ...(await orig<typeof import("../src/api.js")>()),
  getStationTrack: () =>
    Promise.resolve({
      positions: [
        { ts: 100, lat: 47, lon: 13, heardVia: "rf" },
        { ts: 200, lat: 47.1, lon: 13.1, heardVia: "is" },
      ],
    }),
}));
const { TrackReplay } = await import("../src/shack/TrackReplay.js");

/** Just the MapLibre surface the replay uses; `wipe()` does what setStyle does to runtime layers. */
function stubMap() {
  const sources = new Map<string, { data: unknown; setData(d: unknown): void }>();
  const layers = new Set<string>();
  const map = {
    isStyleLoaded: () => true,
    on() {},
    off() {},
    once() {},
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: { data: unknown }) => {
      const s = {
        data: spec.data,
        setData(d: unknown) {
          s.data = d;
        },
      };
      sources.set(id, s);
    },
    removeSource: (id: string) => void sources.delete(id),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: (l: { id: string }) => void layers.add(l.id),
    removeLayer: (id: string) => void layers.delete(id),
    setPaintProperty() {},
    fitBounds() {},
  };
  return {
    map,
    layers,
    sources,
    wipe() {
      sources.clear();
      layers.clear();
    },
  };
}
const count = (src: { data: unknown } | undefined) =>
  (src?.data as { features?: unknown[] } | undefined)?.features?.length ?? -1;

describe("the track replay across a style swap", () => {
  it("re-adds its layers and the loaded track on the next style epoch", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const stub = stubMap();
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (styleEpoch: number) =>
      act(() => root.render(createElement(TrackReplay, { map: stub.map as never, callsign: "OE8APR-9", styleEpoch })));
    render(0);
    const load = [...host.querySelectorAll("button")].find((b) => b.textContent === "Load")!;
    await act(async () => load.click());
    expect(count(stub.sources.get("trk-pts"))).toBe(2);

    stub.wipe();
    render(1);
    expect([...stub.layers].sort()).toEqual(["trk-head-l", "trk-line-l", "trk-pts-l"]);
    expect(count(stub.sources.get("trk-pts"))).toBe(2);
    expect(count(stub.sources.get("trk-line"))).toBe(1);
    expect(count(stub.sources.get("trk-head"))).toBe(1);
    act(() => root.unmount());
  });
});
