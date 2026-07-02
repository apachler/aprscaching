// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { handleEmbed, handleQr } from "../src/embed.js";
import type { Env } from "../src/env.js";

const env = { APP_URL: "https://app.example" } as unknown as Env;

describe("embed widget + QR (docs/design/11 M4)", () => {
  it("/embed?cache= serves a self-contained HTML map referencing the read API", async () => {
    const res = handleEmbed(new Request("https://api.example/embed?cache=ac-0001"), env);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("maplibre-gl");
    expect(body).toContain('"cache":"AC-0001"');         // uppercased into the client config
    expect(body).toContain('"api":"https://api.example"'); // fetches from its own origin
    expect(body).toContain("/api/v1/caches/");
  });

  it("/embed?bbox= configures an area map", async () => {
    const body = await handleEmbed(new Request("https://api.example/embed?bbox=14,46,16,48"), env).text();
    expect(body).toContain('"bbox":"14,46,16,48"');
    expect(body).toContain("fitBounds");
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
