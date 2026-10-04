// SPDX-License-Identifier: AGPL-3.0-or-later
// Imported places keep their source's attribution and stay out of the GPX/KML exports, and a source whose
// terms need the provider's permission imports only once the operator names it in IMPORT_ALLOW.
import { describe, it, expect, afterEach } from "vitest";
import { upsertImported } from "@aprscaching/gateway/import";
import { addCache, instanceEnv, serve } from "./helpers/fedpeer.js";

const BBOX = "bbox=15,47,16,48";
const ingest = { "x-ingest-secret": "test-ingest-secret", "content-type": "application/json" };

async function importOc(env: ReturnType<typeof instanceEnv>) {
  await upsertImported(env, [
    {
      source: "opencaching",
      externalId: "OC1234",
      code: "OC1234",
      type: "traditional",
      title: "Am Schlossberg",
      lat: 47.2,
      lon: 15.2,
      sourceName: "OpenCaching",
      sourceUrl: "https://www.opencaching.de/OC1234",
      ownerCall: "OC",
      sourceOwner: "waldlaeufer",
      sourceAttribution: [
        { text: "© " },
        { text: "waldlaeufer", href: "https://www.opencaching.de/viewprofile.php?userid=1" },
        { text: ", Opencaching.de, CC BY-NC-ND, Stand: 04.10.2026" },
      ],
    },
  ]);
  const row = await env.DB.prepare("SELECT id FROM caches WHERE code = 'OC1234'").first<{ id: number }>();
  return row!.id;
}

describe("imported places and their source's terms", () => {
  it("a cache page carries the source owner and attribution note; the owner call stays the source's", async () => {
    const env = instanceEnv("terms.example", null);
    const fetch = serve(env);
    const id = await importOc(env);
    const res = await fetch(new Request(`https://terms.example/api/caches/${id}`));
    expect(res.status).toBe(200);
    const { cache } = (await res.json()) as { cache: Record<string, unknown> };
    expect(cache.ownerCall).toBe("OC");
    expect(cache.sourceOwner).toBe("waldlaeufer");
    expect(cache.sourceUrl).toBe("https://www.opencaching.de/OC1234");
    expect(cache.sourceAttribution).toEqual([
      { text: "© " },
      { text: "waldlaeufer", href: "https://www.opencaching.de/viewprofile.php?userid=1" },
      { text: ", Opencaching.de, CC BY-NC-ND, Stand: 04.10.2026" },
    ]);
  });

  it("a re-import refreshes the attribution note", async () => {
    const env = instanceEnv("terms.example", null);
    await importOc(env);
    await upsertImported(env, [
      {
        source: "opencaching",
        externalId: "OC1234",
        code: "OC1234",
        type: "traditional",
        title: "Am Schlossberg",
        lat: 47.2,
        lon: 15.2,
        sourceName: "OpenCaching",
        sourceUrl: "https://www.opencaching.de/OC1234",
        sourceOwner: "waldlaeufer",
        sourceAttribution: [{ text: "© waldlaeufer, Opencaching.de, CC BY-NC-ND, Stand: 05.10.2026" }],
      },
    ]);
    const row = await env.DB.prepare("SELECT source_attribution FROM caches WHERE code = 'OC1234'").first<{
      source_attribution: string;
    }>();
    expect(JSON.parse(row!.source_attribution)).toEqual([
      { text: "© waldlaeufer, Opencaching.de, CC BY-NC-ND, Stand: 05.10.2026" },
    ]);
  });

  it("GPX and KML exports hold native caches only", async () => {
    const env = instanceEnv("terms.example", null);
    const fetch = serve(env);
    await addCache(env);
    await importOc(env);
    const gpx = await (await fetch(new Request(`https://terms.example/api/v1/caches.gpx?${BBOX}`))).text();
    expect(gpx).toContain("<name>AC-T");
    expect(gpx).not.toContain("OC1234");
    const kml = await (await fetch(new Request(`https://terms.example/api/v1/caches.kml?${BBOX}`))).text();
    expect(kml).toContain("<name>AC-T");
    expect(kml).not.toContain("OC1234");
    const one = await fetch(new Request("https://terms.example/api/v1/caches/OC1234.gpx"));
    expect(one.status).toBe(404);
  });
});

describe("import sources that need the provider's permission", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses WWFF with the permission it needs, and sends WWFF no request", async () => {
    const env = instanceEnv("terms.example", null);
    const fetch = serve(env);
    let upstream = 0;
    globalThis.fetch = (async () => {
      upstream++;
      return new Response("", { status: 500 });
    }) as typeof globalThis.fetch;
    const res = await fetch(
      new Request("https://terms.example/api/import/wwff", { method: "POST", headers: ingest, body: "{}" }),
    );
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("WWFF's prior permission");
    expect(error).toContain("IMPORT_ALLOW");
    expect(upstream).toBe(0);
  });

  it("imports WWFF once the operator names it in IMPORT_ALLOW", async () => {
    const env = instanceEnv("terms.example", null, { IMPORT_ALLOW: "wwff, iota" });
    const fetch = serve(env);
    globalThis.fetch = (async () =>
      new Response(
        "reference,status,name,latitude,longitude,website\nOEFF-0001,active,Hohe Tauern,47.1,12.6,\n",
      )) as typeof globalThis.fetch;
    const res = await fetch(
      new Request("https://terms.example/api/import/wwff", { method: "POST", headers: ingest, body: "{}" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "wwff", imported: 1 });
  });

  it("lists each source with its state for the sysop", async () => {
    const env = instanceEnv("terms.example", null, { IMPORT_ALLOW: "iota" });
    const fetch = serve(env);
    expect((await fetch(new Request("https://terms.example/api/import"))).status).toBe(401);
    const res = await fetch(new Request("https://terms.example/api/import", { headers: ingest }));
    const { sources } = (await res.json()) as { sources: { id: string; state: string; needs?: string }[] };
    const by = Object.fromEntries(sources.map((s) => [s.id, s]));
    expect(by.wwff).toMatchObject({ state: "needs-permission" });
    expect(by.gcau).toMatchObject({ state: "needs-permission" });
    expect(by.gcau!.needs).toContain("Geocaching Australia");
    expect(by.iota).toMatchObject({ state: "ready" });
    expect(by.sota).toMatchObject({ state: "ready" });
  });
});
