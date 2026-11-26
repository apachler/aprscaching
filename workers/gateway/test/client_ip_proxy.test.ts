// SPDX-License-Identifier: AGPL-3.0-or-later
// Behind a declared reverse proxy (TRUST_PROXY=<n>), the rate-limit identity is the X-Forwarded-For entry the
// operator's own proxy wrote. nginx's `$proxy_add_x_forwarded_for` and Apache's mod_proxy append the peer to
// whatever the client sent, so a client-written entry sits to the left and must never key a limit.
import { describe, expect, it } from "vitest";
import { clientIp } from "../src/corroborate_privacy.js";
import type { Env } from "../src/env.js";

const viaProxy = (xff: string, trust: string) =>
  clientIp(new Request("http://gw/x", { headers: { "x-forwarded-for": xff, "x-real-ip": "10.0.0.1" } }), {
    TRUST_PROXY: trust,
  } as Env);

describe("clientIp behind a declared reverse proxy", () => {
  it("one hop: the rightmost entry, not the one the client sent", () => {
    expect(viaProxy("6.6.6.6, 198.51.100.4", "1")).toBe("198.51.100.4");
    expect(viaProxy("1.1.1.1, 2.2.2.2, 198.51.100.4", "1")).toBe("198.51.100.4");
  });

  it("a client rotating its own X-Forwarded-For keeps one identity", () => {
    const keys = new Set(["7.7.7.1", "7.7.7.2", "7.7.7.3"].map((r) => viaProxy(`${r}, 198.51.100.4`, "1")));
    expect([...keys]).toEqual(["198.51.100.4"]);
  });

  it("n hops: the entry n from the right, which the outermost trusted proxy wrote", () => {
    // client-sent, the client as the outer proxy saw it, the outer proxy as the inner one saw it
    expect(viaProxy("6.6.6.6, 198.51.100.4, 10.0.0.9", "2")).toBe("198.51.100.4");
    expect(viaProxy("6.6.6.6, 198.51.100.4, 10.0.0.9, 10.0.0.8", "3")).toBe("198.51.100.4");
  });

  it("a header shorter than n: the rightmost entry, the only one a client cannot have written", () => {
    // a client that reached the inner proxy directly, skipping the outer one
    expect(viaProxy("6.6.6.6, 198.51.100.4", "3")).toBe("198.51.100.4");
    expect(viaProxy("198.51.100.4", "2")).toBe("198.51.100.4");
  });

  it("a single entry (Caddy replaces the header): that entry", () => {
    expect(viaProxy("198.51.100.4", "1")).toBe("198.51.100.4");
  });

  it("empty entries are skipped, and an empty header falls back to the socket address", () => {
    expect(viaProxy("6.6.6.6, 198.51.100.4, ", "1")).toBe("198.51.100.4");
    expect(viaProxy("", "1")).toBe("10.0.0.1");
  });

  it("TRUST_PROXY 0, unset or not a positive whole number trusts no proxy", () => {
    for (const t of ["0", "", "-1", "1.5", "yes"]) expect(viaProxy("6.6.6.6, 198.51.100.4", t)).toBe("10.0.0.1");
  });
});
