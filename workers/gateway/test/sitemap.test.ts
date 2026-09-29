// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  handleSitemapXml,
  handleSitemapJson,
  handleSitemapPage,
  handleRobots,
  surfaceUrl,
  gatewayBase,
} from "../src/sitemap.js";
import { SURFACES, FEEDS } from "@aprscaching/shared";
import type { Env } from "../src/env.js";

const env = { APP_URL: "https://app.example" } as unknown as Env;
const req = new Request("https://api.example/");

describe("sitemap (manifest-driven)", () => {
  it("manifest is internally consistent: unique keys + views, non-empty fields", () => {
    const keys = SURFACES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    const views = SURFACES.map((s) => s.view).filter(Boolean);
    expect(new Set(views).size).toBe(views.length);
    for (const s of SURFACES) {
      expect(s.label).toBeTruthy();
      expect(s.summary).toBeTruthy();
    }
    expect(SURFACES.filter((s) => s.view === null)).toHaveLength(1); // exactly one root (map)
  });

  it("surfaceUrl roots the map and deep-links panels via ?view=", () => {
    expect(surfaceUrl(env, null)).toBe("https://app.example/");
    expect(surfaceUrl(env, "shack")).toBe("https://app.example/?view=shack");
  });

  it("/sitemap.xml lists exactly the indexable surfaces, well-formed", async () => {
    const body = await handleSitemapXml(req, env).text();
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain("<urlset");
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const expected = SURFACES.filter((s) => s.indexable).map((s) => surfaceUrl(env, s.view));
    expect(locs.sort()).toEqual(expected.sort());
    // non-indexable surfaces (e.g. hide, settings) must not leak into the sitemap
    expect(body).not.toContain("?view=hide");
    expect(body).not.toContain("?view=settings");
  });

  it("/api/sitemap exposes the full manifest + feed catalogue with absolute urls", async () => {
    const data = (await handleSitemapJson(req, env).json()) as any;
    expect(data.protocol).toBe("aprscaching-sitemap/1");
    expect(data.app).toBe("https://app.example");
    expect(data.gateway).toBe("https://api.example");
    expect(data.surfaces).toHaveLength(SURFACES.length);
    expect(data.surfaces.find((s: any) => s.key === "settings").url).toBe("https://app.example/?view=settings");
    expect(data.surfaces.find((s: any) => s.key === "sitemap")).toBeUndefined(); // the site map is a page, not a surface
    expect(data.feeds).toHaveLength(FEEDS.length);
    // feeds are served by the gateway, so they link to its host even when the app lives elsewhere
    for (const f of data.feeds) expect(f.url).toBe(`https://api.example${f.path}`);
  });

  it("/sitemap is a real HTML page listing every surface + feed (not a panel)", async () => {
    const res = handleSitemapPage(req, env);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<h1>Site map</h1>");
    // every surface title is linked on the page (titles are HTML-escaped, e.g. "&" → "&amp;")
    const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    for (const s of SURFACES) expect(body).toContain(`>${esc(s.title)}</a>`);
    // links to the machine endpoints + static pages
    expect(body).toContain('href="https://api.example/sitemap.xml"');
    expect(body).toContain('href="https://api.example/api/sitemap"');
    expect(body).toContain('href="https://api.example/api/v1"');
    expect(body).toContain('href="https://api.example/support"');
    expect(body).toContain('href="https://api.example/source"');
    expect(body).toContain('href="https://app.example/"'); // "Open the app" stays on the app host
  });

  it("/robots.txt advertises the sitemap", async () => {
    const body = await handleRobots(req, env).text();
    expect(body).toContain("Sitemap: https://api.example/sitemap.xml");
    expect(body).toContain("Allow: /");
  });

  it("gatewayBase: the app host keeps APP_URL; another host uses the request host and the proxy's scheme", () => {
    // same-host deployment (Caddy / Docker): the gateway answers on the app's host
    expect(gatewayBase(new Request("http://app.example/robots.txt"), env)).toBe("https://app.example");
    // split deployment (Pages + API host)
    expect(gatewayBase(new Request("https://api.example/robots.txt"), env)).toBe("https://api.example");
    // a TLS-terminating proxy in front of the Node server, which only sees http
    const proxied = new Request("http://api.example/robots.txt", { headers: { "x-forwarded-proto": "https" } });
    expect(gatewayBase(proxied, env)).toBe("https://api.example");
    // no APP_URL: a self-hosted instance links to itself, not to the canonical public host
    expect(gatewayBase(new Request("http://192.168.1.10:8080/robots.txt"), {} as Env)).toBe("http://192.168.1.10:8080");
    // a header raises the scheme of a proxied request, never lowers an https one
    const lowered = new Request("https://api.example/robots.txt", { headers: { "x-forwarded-proto": "http" } });
    expect(gatewayBase(lowered, env)).toBe("https://api.example");
  });
});
