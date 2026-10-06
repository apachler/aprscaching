// SPDX-License-Identifier: AGPL-3.0-or-later
// The Tools app's registries in the browser: a carried registry is fetched through this instance but judged by its
// upstream address, relative entries resolve against the registry and a script against its manifest, a file
// signed by another key is held back as key-changed, a tool several registries list shows once, and a script
// whose bytes differ from the signed hash never runs.
import { describe, expect, it } from "vitest";
import { bytesToB64, sha256B64, signRegistry, type RegistryEntry } from "@aprscaching/tools";
import type { EffectiveToolRegistry } from "../src/api.js";
import {
  CODE_MISMATCH,
  DIRECT,
  carrierFor,
  fetchToolScript,
  groupListings,
  listingFor,
  loadRegistry,
  type LoadedRegistry,
} from "../src/tools/registries.js";

const PAGE = "https://aprscaching.example/shack";
const REG = "https://raw.githubusercontent.com/club/tools/v1/registry.json";

async function keys() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub: bytesToB64(raw, true) };
}
const entry = (name: string, at: string, pubkey = "P"): RegistryEntry => ({
  name,
  title: name,
  author: "OE8APR",
  version: "1",
  pubkey,
  entry: at,
});
const reg = (over: Partial<EffectiveToolRegistry>): EffectiveToolRegistry => ({
  id: "r1",
  scope: "instance",
  spec: "github:club/tools@v1",
  url: REG,
  authority: "",
  label: "Club",
  enabled: true,
  proxied: true,
  ...over,
});

/** A fetch that answers from a table and records what it was asked and how. */
function fakeFetch(table: Record<string, Response | (() => Response)>) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    asked.push({ url, init });
    const hit = table[url];
    return hit ? (typeof hit === "function" ? hit() : hit) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, asked };
}

describe("carrierFor", () => {
  it("routes a carried registry's files through this instance by their upstream address", () => {
    const c = carrierFor(reg({}), "https://api.example");
    expect(c.fetchUrl(REG)).toBe(`https://api.example/api/tools/registries/r1/file?url=${encodeURIComponent(REG)}`);
    expect(c.init.credentials).toBe("omit");
    // a player's own registry is carried for that player alone, so the session goes along
    expect(carrierFor(reg({ scope: "account" }), "").init.credentials).toBe("include");
    expect(carrierFor(reg({ proxied: false }), "")).toBe(DIRECT);
  });
});

describe("loadRegistry", () => {
  it("accepts the pinned key's file, through the carrier", async () => {
    const k = await keys();
    const doc = await signRegistry([entry("hello", "tools/hello/tool.json")], k.pub, k.priv);
    const r = reg({ authority: k.pub });
    const carried = carrierFor(r, "").fetchUrl(REG);
    const { f, asked } = fakeFetch({ [carried]: new Response(JSON.stringify(doc)) });
    const st = await loadRegistry(r, "", PAGE, f);
    expect(st).toMatchObject({ kind: "ok", stale: false });
    expect(asked[0]!.url).toBe(carried);
  });

  it("holds back a file signed by another key as key-changed, with the new key's fingerprint", async () => {
    const a = await keys();
    const b = await keys();
    const doc = await signRegistry([entry("hello", "tools/hello/tool.json")], b.pub, b.priv);
    const { f } = fakeFetch({ [REG]: new Response(JSON.stringify(doc)) });
    const st = await loadRegistry(reg({ authority: a.pub, proxied: false }), "", PAGE, f);
    expect(st).toMatchObject({ kind: "key-changed", authority: b.pub });
    if (st.kind === "key-changed") expect(st.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  });

  it("reports a failure on its own, with the instance's reason", async () => {
    const { f } = fakeFetch({ [REG]: new Response(JSON.stringify({ error: "the host is down" }), { status: 502 }) });
    expect(await loadRegistry(reg({ proxied: false }), "", PAGE, f)).toEqual({
      kind: "failed",
      error: "the host is down",
    });
  });

  it("says the bundled registry is absent on 404, and marks a kept copy stale", async () => {
    const { f } = fakeFetch({});
    const builtin = reg({ id: "builtin", url: "/tools/registry.json", builtin: true, proxied: false });
    expect(await loadRegistry(builtin, "", PAGE, f)).toEqual({ kind: "none" });
    const k = await keys();
    const doc = await signRegistry([], k.pub, k.priv);
    const r = reg({ authority: k.pub });
    const stale = fakeFetch({
      [carrierFor(r, "").fetchUrl(REG)]: new Response(JSON.stringify(doc), {
        headers: { "x-tool-registry-copy": "stale" },
      }),
    });
    expect(await loadRegistry(r, "", PAGE, stale.f)).toMatchObject({ kind: "ok", stale: true });
  });
});

describe("groupListings and listingFor", () => {
  const ok = (r: EffectiveToolRegistry, entries: RegistryEntry[]): LoadedRegistry => ({
    reg: r,
    fingerprint: null,
    state: { kind: "ok", entries, stale: false },
  });

  it("resolves a relative entry two levels deep against the registry's own address", () => {
    const groups = groupListings([ok(reg({}), [entry("hello", "tools/hello/tool.json")])], PAGE);
    expect(groups[0]!.listings[0]!.manifestUrl).toBe(
      "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.json",
    );
    // the bundled registry's absolute path resolves against this instance
    const bundled = groupListings(
      [
        ok(reg({ id: "builtin", url: "/tools/registry.json", builtin: true }), [
          entry("hello", "tools/hello/tool.json"),
        ]),
      ],
      PAGE,
    );
    expect(bundled[0]!.listings[0]!.manifestUrl).toBe("https://aprscaching.example/tools/tools/hello/tool.json");
  });

  it("shows a tool several registries list once, under the first, with every source", () => {
    const shared = entry("hello", "https://tools.example/hello/tool.json");
    const groups = groupListings(
      [
        ok(reg({ id: "a", label: "Instance" }), [shared]),
        ok(reg({ id: "b", label: "Mine", scope: "account" }), [shared, entry("other", "o/tool.json")]),
      ],
      PAGE,
    );
    expect(groups.map((g) => g.listings.map((l) => l.entry.name))).toEqual([["hello"], ["other"]]);
    expect(groups[0]!.listings[0]!.sources).toEqual(["Instance", "Mine"]);
  });

  it("keeps a same-named tool from another address or key apart", () => {
    const groups = groupListings(
      [
        ok(reg({ id: "a" }), [entry("hello", "https://a.example/tool.json")]),
        ok(reg({ id: "b" }), [
          entry("hello", "https://b.example/tool.json"),
          entry("hello", "https://a.example/tool.json", "Q"),
        ]),
      ],
      PAGE,
    );
    expect(groups[1]!.listings).toHaveLength(2);
  });

  it("finds the listing a fetched manifest stands for, the instance's first", () => {
    const loaded = [
      { reg: reg({ id: "x" }), fingerprint: null, state: { kind: "failed", error: "down" } } as LoadedRegistry,
      ok(reg({ id: "a" }), [entry("hello", "tools/hello/tool.json")]),
    ];
    const hit = listingFor(
      loaded,
      "hello",
      "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.json",
      PAGE,
    );
    expect(hit?.from.reg.id).toBe("a");
    expect(listingFor(loaded, "hello", "https://elsewhere.example/tool.json", PAGE)).toBeUndefined();
  });
});

describe("fetchToolScript", () => {
  const script = new TextEncoder().encode("register({});");
  const url = "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.js";

  it("returns the code when its bytes match the signed hash, fetched through the carrier", async () => {
    const r = reg({});
    const carrier = carrierFor(r, "");
    const { f, asked } = fakeFetch({ [carrier.fetchUrl(url)]: () => new Response(script) });
    expect(await fetchToolScript({ entrySha256: await sha256B64(script) }, url, carrier, f)).toEqual({
      ok: true,
      script: "register({});",
    });
    expect(asked[0]!.url).toContain("/api/tools/registries/r1/file?url=");
  });

  it("refuses other bytes and a manifest without a hash", async () => {
    const { f } = fakeFetch({ [url]: () => new Response("register({ evil: 1 });") });
    expect(await fetchToolScript({ entrySha256: await sha256B64(script) }, url, DIRECT, f)).toEqual({
      ok: false,
      error: CODE_MISMATCH,
    });
    expect((await fetchToolScript({}, url, DIRECT, f)).ok).toBe(false);
  });
});
