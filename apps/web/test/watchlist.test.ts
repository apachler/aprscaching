// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Removing a watch and marking alerts seen say when they failed, and the unseen count changes only once the
// instance has taken the change.
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api.js", async (orig) => ({
  ...(await orig<typeof import("../src/api.js")>()),
  listWatch: () => Promise.resolve({ watching: [{ callsign: "OE1ABC" }], unseen: 3 }),
  getWatchAlerts: () => Promise.resolve({ alerts: [], nextCursor: null, hasMore: false }),
  removeWatch: () => Promise.reject(new Error("500 the instance could not remove it")),
  markWatchSeen: () => Promise.reject(new Error("500 the instance could not mark them")),
}));
const { Watchlist } = await import("../src/shack/Watchlist.js");
const { ToastProvider } = await import("../src/ui/Toast.js");

describe("the watchlist's writes", () => {
  it("toasts a failed remove and a failed mark-seen, and keeps the unseen count", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(createElement(ToastProvider, null, createElement(Watchlist, { callsign: "OE8APR" }))),
    );
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find(
        (b) => b.textContent?.includes(label) || b.getAttribute("aria-label") === label,
      )!;
    await act(async () => button("Stop watching OE1ABC").click());
    expect(host.querySelector(".toasts")?.textContent).toContain("could not remove it");

    await act(async () => button("Mark all seen").click());
    expect(host.querySelector(".toasts")?.textContent).toContain("could not mark them");
    expect(host.textContent).toContain("(3 new)");
    act(() => root.unmount());
  });
});
