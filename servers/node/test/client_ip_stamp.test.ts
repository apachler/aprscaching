// SPDX-License-Identifier: AGPL-3.0-or-later
// The self-host runtimes mint the client identity themselves. A client talking straight to a Node or
// Bun server can send any `cf-connecting-ip` it likes, so that header only survives when the operator
// declares a Cloudflare edge in front (TRUST_CF=1); otherwise per-IP rate limits key on the socket.
import { describe, it, expect } from "vitest";
import { clientIp, stampClientIp } from "@aprscaching/gateway/corroborate_privacy";
import type { Env } from "@aprscaching/gateway/env";

const stamped = (h: Record<string, string>, env: Partial<Env>, socket = "192.0.2.50") => {
  const headers = new Headers(h);
  stampClientIp(headers, socket, env as Env);
  return new Request("http://gw/x", { headers });
};

describe("self-host client identity", () => {
  it("drops a client-sent cf-connecting-ip when no Cloudflare edge is declared", () => {
    const req = stamped({ "cf-connecting-ip": "6.6.6.6", "x-real-ip": "7.7.7.7" }, {});
    expect(req.headers.get("cf-connecting-ip")).toBeNull();
    expect(clientIp(req, {} as Env)).toBe("192.0.2.50");
  });

  it("rotating a spoofed header does not rotate the rate-limit key", () => {
    const a = clientIp(stamped({ "cf-connecting-ip": "10.0.0.1" }, {}), {} as Env);
    const b = clientIp(stamped({ "cf-connecting-ip": "10.0.0.2" }, {}), {} as Env);
    expect(a).toBe(b);
  });

  it("keeps cf-connecting-ip behind a declared Cloudflare edge (TRUST_CF=1)", () => {
    const req = stamped({ "cf-connecting-ip": "203.0.113.9" }, { TRUST_CF: "1" }, "127.0.0.1");
    expect(clientIp(req, { TRUST_CF: "1" } as Env)).toBe("203.0.113.9");
  });

  it("always overwrites x-real-ip with the socket address", () => {
    expect(stamped({ "x-real-ip": "7.7.7.7" }, { TRUST_CF: "1" }).headers.get("x-real-ip")).toBe("192.0.2.50");
    expect(stamped({}, {}, "").headers.get("x-real-ip")).toBe("unknown");
  });
});
