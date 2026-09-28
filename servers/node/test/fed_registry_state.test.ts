// SPDX-License-Identifier: AGPL-3.0-or-later
// The DNS-located registry fails closed: its authority key is pinned in config (DNS only says
// where the document lives), a replayed older document is refused, and an unreachable registry
// keeps enforcing the bindings of the last good one instead of dropping to trust-on-first-use.
import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, federationConfigError } from "@aprscaching/gateway/federation";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import {
  newFedKey,
  signedRegistry,
  freshDb,
  instanceEnv,
  addCache,
  serve,
  stubFetch,
  peerRow,
  type FedKey,
  type Serve,
} from "./helpers/fedpeer.js";

afterEach(() => vi.unstubAllGlobals());

const DOH = "https://cloudflare-dns.com";
const REG = "https://reg.example";

/** DoH answers a TXT record pointing at the registry URL (optionally carrying its own key). */
function dohServe(txt: string): Serve {
  return async () => Response.json({ Answer: [{ data: `"${txt}"` }], AD: false });
}

function registryEnv(db: unknown, authority: FedKey | null) {
  return instanceEnv(
    "hub.example",
    null,
    {
      FED_REGISTRY_DNS: "_acsfed.example",
      ...(authority ? { FED_REGISTRY_KEY: authority.pub } : {}),
    },
    db,
  );
}

describe("registry trust anchor", () => {
  it("DNS mode without a pinned FED_REGISTRY_KEY is a configuration error", async () => {
    const env = registryEnv(freshDb().DB, null);
    expect(federationConfigError(env)).toMatch(/FED_REGISTRY_KEY/);
    await expect(loadRegistry(env)).rejects.toThrow(/FED_REGISTRY_KEY/);
  });

  it("ignores a key carried in the TXT record: only the pinned authority signs", async () => {
    const pinned = await newFedKey();
    const dnsKey = await newFedKey();
    const doc = await signedRegistry(dnsKey, 100, [{ instance: "x.example", key: "K" }]);
    stubFetch({ [DOH]: dohServe(`url=${REG}/r.json;key=${dnsKey.pub}`), [REG]: async () => Response.json(doc) });
    expect((await loadRegistry(registryEnv(freshDb().DB, pinned))).size).toBe(0);
  });
});

describe("registry freshness and failure", () => {
  it("rejects a signed registry older than one already accepted", async () => {
    const authority = await newFedKey();
    const { DB } = freshDb();
    const newer = await signedRegistry(authority, 200, [{ instance: "x.example", key: "NEW" }]);
    const older = await signedRegistry(authority, 100, [{ instance: "x.example", key: "OLD" }]);
    const routes = stubFetch({ [DOH]: dohServe(`url=${REG}/r.json`), [REG]: async () => Response.json(newer) });
    expect((await loadRegistry(registryEnv(DB, authority))).get("x.example")?.key).toBe("NEW");
    routes[REG] = async () => Response.json(older);
    expect((await loadRegistry(registryEnv(DB, authority))).get("x.example")?.key).toBe("NEW");
  });

  it("a fetch failure keeps the last good registry's instances bound, so spoofing stays refused", async () => {
    const authority = await newFedKey();
    const genuine = await newFedKey();
    const { DB } = freshDb();
    const doc = await signedRegistry(authority, 100, [{ instance: "x.example", key: genuine.pub }]);
    const routes = stubFetch({ [DOH]: dohServe(`url=${REG}/r.json`), [REG]: async () => Response.json(doc) });
    expect((await loadRegistry(registryEnv(DB, authority))).has("x.example")).toBe(true);

    routes[REG] = async () => new Response("down", { status: 503 });
    const hub = registryEnv(DB, authority);
    expect((await loadRegistry(hub)).get("x.example")?.key).toBe(genuine.pub);

    const impostor = instanceEnv("x.example", await newFedKey());
    await addCache(impostor);
    routes["https://x.example"] = serve(impostor);
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, trust, added_via) VALUES ('https://x.example', 'trusted', 'manual')",
    ).run();
    const r = await syncAllPeers(hub);
    expect(r.errors.join()).toMatch(/registry/);
    expect((await peerRow(hub, "https://x.example"))?.public_key ?? null).toBeNull();
  });
});

describe("rotation tool", () => {
  const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tools/fedkey/rotatekey.mjs");
  const run = (key: FedKey, extra: Record<string, string> = {}) =>
    JSON.parse(
      execFileSync(process.execPath, [TOOL, "--raw"], {
        env: { ...process.env, FED_PRIVATE_KEY: key.env, ...extra },
      }).toString(),
    ) as { FED_KEY_HISTORY: string; FED_ROTATIONS: string };

  it("gives the retired key an until of the rotation time plus the grace (7 days by default)", async () => {
    const out = run(await newFedKey());
    const [hist] = JSON.parse(out.FED_KEY_HISTORY);
    const [rot] = JSON.parse(out.FED_ROTATIONS);
    expect(hist.until).toBe(rot.at + 7 * 86400);
  });

  it("takes the grace from FED_ROTATION_GRACE_DAYS", async () => {
    const out = run(await newFedKey(), { FED_ROTATION_GRACE_DAYS: "2" });
    const [hist] = JSON.parse(out.FED_KEY_HISTORY);
    const [rot] = JSON.parse(out.FED_ROTATIONS);
    expect(hist.until).toBe(rot.at + 2 * 86400);
  });
});
