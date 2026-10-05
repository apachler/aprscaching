// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { handleEmbed, handleQr } from "../src/embed.js";
import type { Env } from "../src/env.js";
import { DEFAULT_BASEMAP_STYLE, GRATICULE_PALETTE, MAPLIBRE_VENDOR_DIR } from "@aprscaching/shared";

// the gateway answers on its own address beside the app's, listed as an address of the instance
const env = { APP_URL: "https://app.example", EXTRA_ORIGINS: "https://api.example" } as unknown as Env;

describe("embed widget + QR", () => {
  it("/embed?cache= serves a self-contained HTML map referencing the read API", async () => {
    const res = handleEmbed(new Request("https://api.example/embed?cache=ac-0001"), env);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("maplibre-gl");
    expect(body).toContain('"cache":"AC-0001"'); // uppercased into the client config
    expect(body).toContain('"api":"https://api.example"'); // fetches from its own origin
    expect(body).toContain("/api/v1/caches/");
  });

  it("/embed?bbox= configures an area map", async () => {
    const body = await handleEmbed(new Request("https://api.example/embed?bbox=14,46,16,48"), env).text();
    expect(body).toContain('"bbox":"14,46,16,48"');
    expect(body).toContain("fitBounds");
  });

  // A payload that tries to break out of the inline <script> must be inert.
  it("neutralises an XSS attempt in bbox (no raw </script> or injected tag)", async () => {
    const attack = "</script><script>alert(1)</script>";
    const res = handleEmbed(new Request("https://api.example/embed?bbox=" + encodeURIComponent(attack)), env);
    const body = await res.text();
    // the only legitimate </script> is the widget's own closing tag → exactly one
    expect(body.match(/<\/script>/gi)?.length).toBe(1); // the widget's own module script, none injected
    expect(body).not.toContain("<script>alert(1)");
    // an invalid bbox is dropped to null, never reflected verbatim
    expect(body).toContain('"bbox":null');
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors *");
  });

  it("strips markup from the cache param before it reaches the page", async () => {
    const res = handleEmbed(new Request("https://api.example/embed?cache=" + encodeURIComponent("</script><b>x")), env);
    const body = await res.text();
    expect(body.match(/<\/script>/gi)?.length).toBe(1); // the widget's own module script, none injected
    expect(body).not.toContain("<b>x");
  });

  it("accepts a valid four-number bbox", async () => {
    const body = await handleEmbed(new Request("https://api.example/embed?bbox=14,46,16,48"), env).text();
    expect(body).toContain('"bbox":"14,46,16,48"');
  });

  it("loads nothing from a CDN or a hardcoded tile server", async () => {
    const res = handleEmbed(new Request("https://api.example/embed?cache=AC-0001"), env);
    const all = (await res.text()) + (res.headers.get("content-security-policy") ?? "");
    expect(all).not.toContain("unpkg.com");
    expect(all).not.toContain("tile.openstreetmap.org");
  });

  it("loads the MapLibre script, stylesheet and worker from the vendored path of the address it was loaded from", async () => {
    const res = handleEmbed(new Request("https://api.example/embed?cache=AC-0001"), env);
    const body = await res.text();
    const dir = `https://api.example/${MAPLIBRE_VENDOR_DIR}`;
    expect(MAPLIBRE_VENDOR_DIR).toMatch(/^vendor\/maplibre-gl\/\d+$/);
    expect(body).toContain(`<link href="${dir}/maplibre-gl.css" rel="stylesheet">`);
    expect(body).toContain(`"lib":"${dir}/maplibre-gl.js"`);
    expect(body).toContain(`"worker":"${dir}/maplibre-gl-worker.js"`);
    expect(body).toContain("setWorkerUrl(CFG.worker)");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'unsafe-inline' 'self'");
    expect(csp).toContain("style-src 'unsafe-inline' 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it("stays on the HAMNET address it was loaded from, and answers an unknown host for APP_URL", async () => {
    const multi = { APP_URL: "https://app.example", EXTRA_ORIGINS: "http://44.143.1.2" } as unknown as Env;
    const hamnet = await handleEmbed(new Request("http://44.143.1.2/embed?cache=AC-0001"), multi).text();
    expect(hamnet).toContain(`"lib":"http://44.143.1.2/${MAPLIBRE_VENDOR_DIR}/maplibre-gl.js"`);
    expect(hamnet).toContain('"app":"http://44.143.1.2"');
    const forged = await handleEmbed(new Request("http://evil.test/embed?cache=AC-0001"), multi).text();
    expect(forged).not.toContain("evil.test");
    expect(forged).toContain('"api":"https://app.example"');
  });

  it("serves MapLibre from its own origin when no APP_URL names another host", async () => {
    const res = handleEmbed(new Request("https://desk.example/embed?bbox=14,46,16,48"), {} as unknown as Env);
    const body = await res.text();
    expect(body).toContain(`"lib":"https://desk.example/${MAPLIBRE_VENDOR_DIR}/maplibre-gl.js"`);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline' 'self';");
  });

  it("defaults to the SPA's default basemap and allows only that style's origin", async () => {
    const res = handleEmbed(new Request("https://api.example/embed?cache=AC-0001"), env);
    const body = await res.text();
    expect(body).toContain(`"style":"${DEFAULT_BASEMAP_STYLE}"`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`connect-src 'self' ${new URL(DEFAULT_BASEMAP_STYLE).origin}`);
  });

  it("with BASEMAP_STYLE=offline draws the built-in grid and the CSP names no external host", async () => {
    const offline = { BASEMAP_STYLE: "offline" } as unknown as Env; // the gateway serves the SPA too
    const res = handleEmbed(new Request("https://gw.example/embed?cache=AC-0001"), offline);
    const body = await res.text();
    expect(body).toContain('"style":null');
    expect(body).toContain(`"grid":${JSON.stringify(GRATICULE_PALETTE)}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/https?:/);
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-ancestors *");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("with a custom style URL allows that origin and the listed extra tile hosts", async () => {
    const custom = {
      APP_URL: "https://app.example",
      BASEMAP_STYLE: "http://tiles.hamnet.example:8080/styles/basic/style.json",
      BASEMAP_HOSTS: "https://glyphs.example/fonts, not a url, javascript:alert(1)",
    } as unknown as Env;
    const res = handleEmbed(new Request("https://api.example/embed?bbox=14,46,16,48"), custom);
    const body = await res.text();
    expect(body).toContain('"style":"http://tiles.hamnet.example:8080/styles/basic/style.json"');
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' http://tiles.hamnet.example:8080 https://glyphs.example;");
    expect(csp).toContain("img-src 'self' data: blob: http://tiles.hamnet.example:8080 https://glyphs.example;");
    expect(csp).not.toContain("javascript");
    expect(csp).not.toContain("not a url");
  });

  it("treats an unusable BASEMAP_STYLE as offline rather than trusting it", async () => {
    for (const bad of ["javascript:alert(1)", "ftp://x.example/style.json", "just words"]) {
      const res = handleEmbed(new Request("https://gw.example/embed"), { BASEMAP_STYLE: bad } as unknown as Env);
      expect(await res.text()).toContain('"style":null');
      expect(res.headers.get("content-security-policy")).not.toMatch(/https?:|javascript/);
    }
  });

  it("keeps a hostile APP_URL out of the markup and the script", async () => {
    const hostile = { APP_URL: 'https://app.example/"></script><script>alert(1)</script>' } as unknown as Env;
    const body = await handleEmbed(new Request("https://api.example/embed?cache=AC-0001"), hostile).text();
    expect(body).not.toContain("<script>alert(1)");
    expect(body.match(/<\/script>/gi)?.length).toBe(1);
  });

  it("/embed/qr.svg?cache= returns an SVG QR of the cache share link", () => {
    const res = handleQr(new Request("https://api.example/embed/qr.svg?cache=AC-0001&size=180"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/svg\+xml/);
  });

  it("/embed/qr.svg rejects data beyond QR capacity", () => {
    const res = handleQr(new Request("https://api.example/embed/qr.svg?url=" + "x".repeat(200)), env);
    expect(res.status).toBe(400);
  });
});
