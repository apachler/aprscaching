// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// A tour keeps the instance out of reach when the gateway lives on another origin (`VITE_API_BASE`) too: the
// fixtures answer its API, a write never leaves the browser, and anything else goes without the visitor's cookies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/rf/RadioLinkHost.js", () => ({ radioLink: { subscribe: () => () => {}, getState: () => ({}) } }));

const API = "https://api.example";

describe("a tour with the gateway on another origin", { timeout: 60_000 }, () => {
  let seen: Request[];
  beforeEach(async () => {
    seen = [];
    vi.stubEnv("VITE_API_BASE", API);
    vi.resetModules();
    window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response("network", { status: 200 });
    }) as typeof fetch;
    const { enterTour } = await import("../src/demo/tourMode.js");
    enterTour("game");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers the gateway's API from the fixtures, so the visitor's own account never loads", async () => {
    const res = await fetch(`${API}/api/me`, { credentials: "include" });
    expect(seen).toEqual([]);
    expect(res.status).not.toBe(503);
    expect(await res.text()).not.toBe("network");
  });

  it("keeps a write in the browser", async () => {
    const res = await fetch(`${API}/api/finds`, { method: "POST", credentials: "include", body: "{}" });
    expect(seen).toEqual([]);
    expect(await res.json()).toEqual({ ok: true });
    await fetch(`${API}/ingest`, { method: "POST", credentials: "include", body: "{}" });
    expect(seen).toEqual([]);
  });

  it("sends any other read to the gateway without the visitor's cookies", async () => {
    await fetch(`${API}/badge/OE8APR.svg`, { credentials: "include" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.credentials).toBe("omit");
  });

  it("leaves a third party's reads (the basemap's tiles) alone", async () => {
    await fetch("https://tiles.example/0/0/0.pbf");
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).origin).toBe("https://tiles.example");
  });
});
