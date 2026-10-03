// SPDX-License-Identifier: AGPL-3.0-or-later
// The box's gateway credential: the shared secret as it is, or — once enrolled — a signature in its place.
import { describe, it, expect, vi, afterEach } from "vitest";
import { gatewayFetch, loadBoxKey, newBoxKey, useBoxKey } from "../src/gatewayauth.js";

afterEach(() => {
  useBoxKey(null);
  vi.unstubAllGlobals();
});

function capture() {
  const seen: Headers[] = [];
  vi.stubGlobal("fetch", async (_u: unknown, init: RequestInit) => {
    seen.push(new Headers(init.headers));
    return new Response("{}");
  });
  return seen;
}

describe("gatewayFetch", () => {
  it("sends the shared secret unchanged while the box has no key", async () => {
    const seen = capture();
    await gatewayFetch("http://gw/ingest", { method: "POST", headers: { "x-ingest-secret": "s" }, body: "{}" });
    expect(seen[0]!.get("x-ingest-secret")).toBe("s");
    expect(seen[0]!.has("x-box-sig")).toBe(false);
  });

  it("replaces the secret with a signature once the box has a key", async () => {
    const seen = capture();
    const { boxKey } = newBoxKey();
    useBoxKey(loadBoxKey({ BOX_ID: "shack-1", BOX_KEY: boxKey }));
    await gatewayFetch("http://gw/ingest?x=1", { method: "POST", headers: { "x-ingest-secret": "s" }, body: "{}" });
    const h = seen[0]!;
    expect(h.has("x-ingest-secret")).toBe(false);
    expect(h.get("x-box-id")).toBe("shack-1");
    expect(h.get("x-box-sig")).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(Number(h.get("x-box-at"))).toBeGreaterThan(0);
  });

  it("leaves requests that are not to the gateway alone", async () => {
    const seen = capture();
    const { boxKey } = newBoxKey();
    useBoxKey(loadBoxKey({ BOX_ID: "shack-1", BOX_KEY: boxKey }));
    await gatewayFetch("https://elsewhere.example/feed");
    expect(seen[0]!.has("x-box-sig")).toBe(false);
  });
});

describe("loadBoxKey", () => {
  it("is null without BOX_KEY, and refuses a key without its box id", () => {
    expect(loadBoxKey({})).toBeNull();
    expect(() => loadBoxKey({ BOX_KEY: newBoxKey().boxKey })).toThrow(/BOX_ID/);
  });

  it("derives the public key the box registered", () => {
    const { boxKey, publicKey } = newBoxKey();
    expect(loadBoxKey({ BOX_ID: "b", BOX_KEY: boxKey })!.publicKey).toBe(publicKey);
  });
});

describe("gatewayFetch timeout", () => {
  it("gives a request without its own signal a deadline, and keeps a signal the caller set", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", async (_i: unknown, init: RequestInit) => {
      signals.push(init.signal);
      return new Response("{}");
    });
    await gatewayFetch("http://gw/ingest/check", { headers: { "x-ingest-secret": "s" } });
    const own = new AbortController().signal;
    await gatewayFetch("http://gw/ingest/check", { signal: own });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(own);
  });
});
