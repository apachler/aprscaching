// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The stage list shows the stages of the cache it is rendered for: an earlier request that answers late
// (another cache, or the same cache before sign-in) never replaces the newer list.
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const pending: { cacheId: number; resolve: (v: unknown) => void }[] = [];
vi.mock("../src/api.js", async (orig) => ({
  ...(await orig<typeof import("../src/api.js")>()),
  getStages: (cacheId: number) => new Promise((resolve) => pending.push({ cacheId, resolve })),
}));
const { StagesSection } = await import("../src/log/StagesSection.js");

const stage = (clue: string) => ({ stages: [{ stageNo: 0, unlocked: true, unlock: "geo", clue }] });

describe("the stage list", () => {
  it("keeps the newer cache's stages when the older request answers last", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(StagesSection, { cacheId: 1, callsign: "OE8APR" })));
    act(() => root.render(createElement(StagesSection, { cacheId: 2, callsign: "OE8APR" })));
    const first = pending.find((p) => p.cacheId === 1)!;
    const second = pending.find((p) => p.cacheId === 2)!;
    await act(async () => second.resolve(stage("clue of cache two")));
    await act(async () => first.resolve(stage("clue of cache one")));
    expect(host.textContent).toContain("clue of cache two");
    expect(host.textContent).not.toContain("clue of cache one");
    act(() => root.unmount());
  });
});
