// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The cache sheet stays mounted while another cache opens in it, so everything that belongs to one cache —
// the log form's result, the stage list, a page of older logs still on its way — must not carry over to the
// next, and the favourite heart answers a signed-out visitor.
import { createElement, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mounts: { form: number[]; stages: number[] } = { form: [], stages: [] };

vi.mock("../src/log/LogForm.js", () => ({
  LogForm: (p: { cacheId: number }) => {
    // the id this instance was first rendered for: a stale instance shows the previous cache's id
    const [first] = useState(() => {
      mounts.form.push(p.cacheId);
      return p.cacheId;
    });
    return createElement("p", { "data-testid": "logform" }, `form for ${first}`);
  },
}));
vi.mock("../src/log/StagesSection.js", () => ({
  StagesSection: (p: { cacheId: number }) => {
    const [first] = useState(() => {
      mounts.stages.push(p.cacheId);
      return p.cacheId;
    });
    return createElement("p", { "data-testid": "stages" }, `stages for ${first}`);
  },
}));
const nothing = () => null;
vi.mock("../src/caches/NavigateCache.js", () => ({ NavigateCache: nothing }));
vi.mock("../src/caches/FindView.js", () => ({ FindView: nothing }));
vi.mock("../src/caches/CacheMedia.js", () => ({ CacheMedia: nothing }));
vi.mock("../src/caches/EditCachePanel.js", () => ({ EditCachePanel: nothing }));
vi.mock("../src/moderation/ContentMenu.js", () => ({ ContentMenu: nothing }));
vi.mock("../src/packet/PacketRoute.js", () => ({ PacketRoute: nothing }));
vi.mock("../src/exports/ExportButton.js", () => ({ ExportButton: nothing }));

const getCacheLogs = vi.fn();
const toggleFavorite = vi.fn();
vi.mock("../src/api.js", async (orig) => ({
  ...(await orig<typeof import("../src/api.js")>()),
  getCacheLogs: (...a: unknown[]) => getCacheLogs(...a),
  toggleFavorite: (...a: unknown[]) => toggleFavorite(...a),
  getCacheAdoption: () => new Promise(() => {}),
}));

const { DetailPanel } = await import("../src/caches/DetailPanel.js");
const { PlatformContext } = await import("../src/platform/PlatformContext.js");
type Detail = Parameters<typeof DetailPanel>[0]["detail"];

function cache(id: number, extra: Partial<Detail> = {}): Detail {
  return {
    id,
    code: `AC${id}`,
    title: `Cache ${id}`,
    type: "traditional",
    source: "imported",
    sourceName: "elsewhere",
    ownerCall: "OE1ABC",
    status: "active",
    difficulty: 1,
    terrain: 1,
    finds: 0,
    favorites: 0,
    favorited: false,
    tags: [],
    rendezvous: [],
    stageCount: 1,
    logs: [],
    logsCursor: null,
    logsHasMore: false,
    rating: { policy: "off", avg: null, count: 0, mine: null, canRate: false },
    lat: null,
    lon: null,
    ...extra,
  } as unknown as Detail;
}

let root: Root, host: HTMLElement;
const onSignIn = vi.fn();
function render(detail: Detail, callsign = "OE8APR") {
  const session = { callsign, verified: true, signedIn: callsign !== "" };
  act(() =>
    root.render(
      createElement(
        PlatformContext.Provider,
        { value: { session, map: null } as never },
        createElement(DetailPanel, { detail, onClose() {}, onLogged() {}, onSignIn }),
      ),
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounts.form = [];
  mounts.stages = [];
  getCacheLogs.mockReset();
  toggleFavorite.mockReset();
  onSignIn.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the cache sheet switching to another cache", () => {
  it("gives the next cache a fresh log form and stage list", () => {
    render(cache(1));
    render(cache(2));
    expect(host.textContent).toContain("form for 2");
    expect(host.textContent).toContain("stages for 2");
    expect(host.textContent).not.toContain("for 1");
    expect(new Set(mounts.form)).toEqual(new Set([1, 2]));
    expect(new Set(mounts.stages)).toEqual(new Set([1, 2]));
  });

  it("drops a page of the previous cache's logbook that answers after the switch", async () => {
    let answer!: (v: unknown) => void;
    getCacheLogs.mockReturnValue(new Promise((r) => (answer = r)));
    render(cache(1, { logsCursor: "c1", logsHasMore: true } as Partial<Detail>));
    const more = [...host.querySelectorAll("button")].find((b) => b.textContent === "Load more")!;
    act(() => more.click());
    render(cache(2));
    const old = { id: 99, cacheId: 1, logType: "found", loggerCall: "OE1OLD", ts: 0, verified: false };
    await act(async () => answer({ logs: [old], nextCursor: null, hasMore: false }));
    expect(host.textContent).not.toContain("OE1OLD");
  });
});

describe("the favourite heart", () => {
  it("sends a signed-out visitor to sign in instead of doing nothing", () => {
    render(cache(1), "");
    const heart = host.querySelector<HTMLButtonElement>("button.heart")!;
    act(() => heart.click());
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(toggleFavorite).not.toHaveBeenCalled();
  });
});
