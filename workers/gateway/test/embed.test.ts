// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { handleEmbed, handleQr } from "../src/embed.js";
import type { Env } from "../src/env.js";

const env = { APP_URL: "https://app.example" } as unknown as Env;

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

  // SR-SEC-03: a payload that tries to break out of the inline <script> must be inert.
  it("neutralises an XSS attempt in bbox (no raw </script> or injected tag)", async () => {
    const attack = "</script><script>alert(1)</script>";
    const res = handleEmbed(new Request("https://api.example/embed?bbox=" + encodeURIComponent(attack)), env);
    const body = await res.text();
    // the only legitimate </script> is the widget's own closing tag → exactly one
    expect(body.match(/<\/script>/gi)?.length).toBe(2); // two legit tags (external + inline), none injected
    expect(body).not.toContain("<script>alert(1)");
    // an invalid bbox is dropped to null, never reflected verbatim
    expect(body).toContain('"bbox":null');
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors *");
  });

  it("strips markup from the cache param before it reaches the page", async () => {
    const res = handleEmbed(new Request("https://api.example/embed?cache=" + encodeURIComponent("</script><b>x")), env);
    const body = await res.text();
    expect(body.match(/<\/script>/gi)?.length).toBe(2); // two legit tags (external + inline), none injected
    expect(body).not.toContain("<b>x");
  });

  it("accepts a valid four-number bbox", async () => {
    const body = await handleEmbed(new Request("https://api.example/embed?bbox=14,46,16,48"), env).text();
    expect(body).toContain('"bbox":"14,46,16,48"');
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
