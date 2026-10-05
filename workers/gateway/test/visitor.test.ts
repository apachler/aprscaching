// SPDX-License-Identifier: AGPL-3.0-or-later
// A visitor's phone on an off-grid station's Wi-Fi hotspot reaches the gateway at the Node server's own
// https listener on one of the station's private IPv4 addresses. That origin, and APP_URL, are the only
// origins an operator sign-in link may name: never a public address, another port, plain http, a name,
// or anything carrying a path, credentials or a query.
import { describe, it, expect } from "vitest";
import { hotspotOrigin, linkOrigin } from "../src/visitor.js";
import type { Env } from "../src/env.js";

const pocket = (extra: Partial<Env> = {}) =>
  ({ APP_URL: "http://localhost:8787", HTTPS_LISTENER_PORT: "8443", ...extra }) as Env;

describe("hotspotOrigin", () => {
  it("accepts https on the listener's port at an RFC 1918 address", () => {
    for (const o of [
      "https://192.168.43.1:8443",
      "https://10.0.0.1:8443/",
      "https://172.16.5.9:8443",
      "https://172.31.255.1:8443",
    ])
      expect(hotspotOrigin(o, pocket())).toBe(o.replace(/\/$/, ""));
  });

  it("rejects everything else", () => {
    for (const o of [
      "https://8.8.8.8:8443", // public
      "https://172.32.0.1:8443", // outside 172.16/12
      "https://127.0.0.1:8443", // loopback: no other device can open it
      "https://169.254.1.1:8443", // link-local
      "https://192.168.43.1:9443", // another port
      "https://192.168.43.1", // the default port is not the listener's
      "http://192.168.43.1:8443", // plain http
      "https://evil.test:8443", // a name
      "https://[fd00::1]:8443", // IPv6
      "https://192.168.43.1:8443/auth", // a path
      "https://192.168.43.1:8443/?x=1", // a query
      "https://user@192.168.43.1:8443", // credentials
      "javascript:alert(1)",
      "not a url",
      "",
    ])
      expect(hotspotOrigin(o, pocket()), o).toBeNull();
  });

  it("is closed while no https listener runs", () => {
    expect(hotspotOrigin("https://192.168.43.1:8443", pocket({ HTTPS_LISTENER_PORT: undefined }))).toBeNull();
  });

  it("accepts the default port only when the listener runs on 443", () => {
    expect(hotspotOrigin("https://192.168.43.1", pocket({ HTTPS_LISTENER_PORT: "443" }))).toBe("https://192.168.43.1");
  });
});

describe("linkOrigin", () => {
  const listed = ["http://localhost:8787", "http://aprscaching.oe8xyz.hamnet.example"];
  it("is an address of the instance, or the hotspot origin, and nothing else", () => {
    expect(linkOrigin("http://aprscaching.oe8xyz.hamnet.example/", pocket(), listed)).toBe(
      "http://aprscaching.oe8xyz.hamnet.example",
    );
    expect(linkOrigin("http://localhost:8787", pocket(), listed)).toBe("http://localhost:8787");
    expect(linkOrigin("http://localhost:8787/", pocket(), listed)).toBe("http://localhost:8787");
    expect(linkOrigin("https://192.168.43.1:8443", pocket(), listed)).toBe("https://192.168.43.1:8443");
    expect(linkOrigin("https://localhost:8787", pocket(), listed)).toBeNull();
    expect(linkOrigin("http://localhost:8787/x", pocket(), listed)).toBeNull();
    expect(linkOrigin("https://evil.test", pocket(), listed)).toBeNull();
  });
});
