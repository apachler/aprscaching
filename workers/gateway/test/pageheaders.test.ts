// SPDX-License-Identifier: AGPL-3.0-or-later
// The gateway's HTML pages carry the instance's page headers; what a page sets itself wins, and an API answer
// is left as it is.
import { describe, it, expect } from "vitest";
import { PAGE_HEADERS, withPageHeaders } from "../src/pageheaders.js";

const page = (headers: Record<string, string>) =>
  withPageHeaders(
    new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
    }),
  );

describe("withPageHeaders", () => {
  it("adds every page header to an HTML page", async () => {
    const res = page({});
    for (const [k, v] of Object.entries(PAGE_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(await res.text()).toBe("<!doctype html>");
  });

  it("keeps a page's own policy, and adds no X-Frame-Options beside it", () => {
    const res = page({ "content-security-policy": "frame-ancestors *", "referrer-policy": "no-referrer" });
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors *");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("a page that denies framing keeps denying it under the policy browsers read first", () => {
    const res = page({ "x-frame-options": "DENY" });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("frame-ancestors 'self'");
  });

  it("leaves a non-HTML answer alone", () => {
    const res = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(withPageHeaders(res)).toBe(res);
  });
});
