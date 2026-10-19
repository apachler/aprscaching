// SPDX-License-Identifier: AGPL-3.0-or-later
// The push-to-hub submit path binds identity the same way the pull path does: a secret-holder can
// never submit as an instance the hub already knows under another key, a blocked spoke stays out,
// and a new spoke enters unvetted until the operator promotes it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { keyFingerprint } from "@aprscaching/gateway/federation";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { newFedKey, instanceEnv, addCache, serve, peerRow, stubFetch } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = "submit-secret";

async function submitPage(hub: Env, spoke: Env) {
  const page = await (await serve(spoke)(new Request("https://spoke/federation/sync/cache?since=0"))).arrayBuffer();
  return serve(hub)(
    new Request("https://hub.example/federation/submit", {
      method: "POST",
      headers: { "content-type": "application/cbor", "x-fed-secret": SECRET },
      body: page,
    }),
  );
}

async function hub() {
  return instanceEnv("hub.example", await newFedKey(), { FED_SUBMIT_SECRET: SECRET });
}

describe("submit identity", () => {
  it("refuses a submission as an already-pulled instance under a different key", async () => {
    const h = await hub();
    const genuine = await newFedKey();
    await h.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES ('https://s.example', 's.example', ?, 'trusted', 'manual')",
    )
      .bind(genuine.pub)
      .run();
    const impostor = instanceEnv("s.example", await newFedKey());
    await addCache(impostor);
    const res = await submitPage(h, impostor);
    expect(res.status).toBe(403);
    expect((await h.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches").first<{ n: number }>())?.n).toBe(0);
  });

  it("refuses a blocked spoke", async () => {
    const h = await hub();
    const key = await newFedKey();
    const spoke = instanceEnv("s.example", key);
    await addCache(spoke);
    await h.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via, enabled) VALUES ('submit:s.example', 's.example', ?, 'blocked', 'submitted', 0)",
    )
      .bind(key.pub)
      .run();
    const res = await submitPage(h, spoke);
    expect(res.status).toBe(403);
    expect((await h.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches").first<{ n: number }>())?.n).toBe(0);
  });

  it("registers a new spoke as unvetted", async () => {
    const h = await hub();
    const spoke = instanceEnv("s.example", await newFedKey());
    await addCache(spoke);
    const res = await submitPage(h, spoke);
    expect(res.status).toBe(200);
    expect((await peerRow(h, "submit:s.example"))?.trust).toBe("unvetted");
  });

  it("accepts a known spoke's next submission under its pinned key", async () => {
    const h = await hub();
    const spoke = instanceEnv("s.example", await newFedKey());
    await addCache(spoke);
    expect((await submitPage(h, spoke)).status).toBe(200);
    await addCache(spoke, 2000);
    const res = await submitPage(h, spoke);
    expect(res.status).toBe(200);
    // the new cache applies; the first one, re-sent at the version already applied, is skipped
    expect(await res.json()).toMatchObject({ applied: 1, rejected: 1 });
  });
});

describe("a configured peer this hub has not pulled yet is reserved", () => {
  afterEach(() => vi.unstubAllGlobals());
  const configure = (h: Env, fingerprint: string | null = null) =>
    h.DB.prepare(
      "INSERT INTO fed_peers (url, trust, added_via, pinned_fingerprint) VALUES ('https://s.example', 'unvetted', 'manual', ?)",
    )
      .bind(fingerprint)
      .run();
  const cached = async (e: Env) =>
    (await e.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches").first<{ n: number }>())?.n;

  it("refuses a submission as a FED_PEERS instance not yet synced, and the pull binds the genuine peer", async () => {
    const h = await hub();
    await configure(h);
    const impostor = instanceEnv("s.example", await newFedKey());
    await addCache(impostor);
    expect((await submitPage(h, impostor)).status).toBe(403);
    expect(await peerRow(h, "submit:s.example")).toBeFalsy();
    expect(await cached(h)).toBe(0);

    const genuine = instanceEnv("s.example", await newFedKey());
    await addCache(genuine);
    stubFetch({ "https://s.example": serve(genuine) });
    expect((await syncAllPeers(h)).errors).toEqual([]);
    expect((await peerRow(h, "https://s.example"))?.instance).toBe("s.example");
    expect(await cached(h)).toBe(1);
  });

  it("accepts the submission when its key matches the fingerprint the sysop pinned", async () => {
    const h = await hub();
    const key = await newFedKey();
    await configure(h, await keyFingerprint(key.pub));
    const spoke = instanceEnv("s.example", key);
    await addCache(spoke);
    expect((await submitPage(h, spoke)).status).toBe(200);
    expect(await cached(h)).toBe(1);
  });

  it("refuses a submission as an instance whose row carries no key yet", async () => {
    const h = await hub();
    await h.DB.prepare(
      "INSERT INTO fed_peers (url, instance, trust, added_via) VALUES ('https://s.example', 's.example', 'unvetted', 'registry')",
    ).run();
    const impostor = instanceEnv("s.example", await newFedKey());
    await addCache(impostor);
    expect((await submitPage(h, impostor)).status).toBe(403);
    expect(await cached(h)).toBe(0);
  });
});
