// SPDX-License-Identifier: AGPL-3.0-or-later
// The push-to-hub submit path binds identity the same way the pull path does: a secret-holder can
// never submit as an instance the hub already knows under another key, a blocked spoke stays out,
// and a new spoke enters unvetted until the operator promotes it.
import { describe, it, expect } from "vitest";
import { newFedKey, instanceEnv, addCache, serve, peerRow } from "./helpers/fedpeer.js";
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
    expect(((await res.json()) as { applied: number }).applied).toBe(2);
  });
});
