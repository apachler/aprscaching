// SPDX-License-Identifier: AGPL-3.0-or-later
// The service worker (public/sw.js) run against a stand-in for the worker globals: it stores the app shell
// on install, opens the app offline from it, leaves API calls and gateway pages alone, waits for the user
// before replacing a running version, and still shows push notifications.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { idbStore } from "../src/offline/store.js";

const SRC = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/sw.js"), "utf8");
const ORIGIN = "https://app.example";

type Handler = (event: Record<string, unknown>) => void;

/** Load the worker with `list` as its precache list; `net` answers the network, or throws when offline. */
function load(
  opts: {
    list?: string[];
    active?: boolean;
    net?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  } = {},
) {
  const src = SRC.replace('const VERSION = "dev";', 'const VERSION = "v2";').replace(
    "const PRECACHE = [];",
    `const PRECACHE = ${JSON.stringify(opts.list ?? ["/index.html", "/assets/app.js"])};`,
  );
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, Response>>([["acs-shell-v1", new Map()]]);
  const calls = {
    skipWaiting: 0,
    claimed: 0,
    notifications: [] as unknown[],
    focused: 0,
    fetched: [] as string[],
    messages: [] as unknown[],
  };
  const net = opts.net ?? ((u: string) => new Response(`net:${u}`));
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.fetched.push(url);
    return net(url, init);
  };
  const caches = {
    open: async (name: string) => {
      const m = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, m);
      return {
        addAll: async (reqs: Request[]) => {
          for (const r of reqs) m.set(new URL(r.url, ORIGIN).pathname, await fetchFn(r));
        },
      };
    },
    match: async (key: string, o: { cacheName: string }) => stores.get(o.cacheName)?.get(key)?.clone(),
    keys: async () => [...stores.keys()],
    delete: async (k: string) => stores.delete(k),
  };
  const self = {
    location: { origin: ORIGIN },
    registration: {
      active: opts.active ? {} : null,
      showNotification: async (title: string, o: unknown) => void calls.notifications.push({ title, ...(o as object) }),
    },
    clients: {
      claim: async () => void calls.claimed++,
      matchAll: async () => [
        { focus: () => void calls.focused++, postMessage: (m: unknown) => void calls.messages.push(m) },
      ],
      openWindow: async () => null,
    },
    skipWaiting: async () => void calls.skipWaiting++,
    addEventListener: (type: string, h: Handler) => (handlers[type] = h),
  };
  // a worker resolves a relative URL against its origin; Node's Request needs it absolute
  const WorkerRequest = class extends Request {
    constructor(u: string, init?: RequestInit) {
      super(new URL(u, ORIGIN), { ...init, cache: undefined });
    }
  };
  new Function("self", "caches", "fetch", "Request", src)(self, caches, fetchFn, WorkerRequest);

  /** Dispatch an event; resolves with what it waited on and what it responded with. */
  async function fire(type: string, extra: Record<string, unknown> = {}) {
    let waited: Promise<unknown> | undefined;
    let responded: Promise<Response> | undefined;
    handlers[type]!({
      ...extra,
      waitUntil: (p: Promise<unknown>) => (waited = p),
      respondWith: (p: Promise<Response>) => (responded = p),
    });
    await waited;
    return responded ? await responded : undefined;
  }
  // a navigation's mode is set by the browser; Node's Request has it read-only, so shadow it
  const req = (p: string, mode = "cors") => {
    const request = new Request(ORIGIN + p);
    Object.defineProperty(request, "mode", { value: mode });
    return { request };
  };
  return { fire, req, stores, calls, handlers };
}

describe("the offline app shell", () => {
  it("stores the shell on install, and the first worker takes over at once", async () => {
    const w = load();
    await w.fire("install");
    expect([...w.stores.get("acs-shell-v2")!.keys()].sort()).toEqual(["/assets/app.js", "/index.html"]);
    expect(w.calls.skipWaiting).toBe(1);
  });

  it("a new version waits for the user, then takes over on request", async () => {
    const w = load({ active: true });
    await w.fire("install");
    expect(w.calls.skipWaiting).toBe(0);
    await w.fire("message", { data: { type: "SKIP_WAITING" } });
    expect(w.calls.skipWaiting).toBe(1);
  });

  it("deletes older shells on activate", async () => {
    const w = load();
    await w.fire("install");
    await w.fire("activate");
    expect([...w.stores.keys()]).toEqual(["acs-shell-v2"]);
    expect(w.calls.claimed).toBe(1);
  });

  it("opens the app from the stored shell without a connection", async () => {
    let online = true;
    const w = load({ net: (u) => (online ? new Response(`net:${u}`) : Promise.reject(new TypeError("offline"))) });
    await w.fire("install");
    online = false;
    const res = await w.fire("fetch", w.req("/?view=nearby", "navigate"));
    expect(await res!.text()).toBe(`net:${ORIGIN}/index.html`);
  });

  it("prefers the network for the app when it answers", async () => {
    const w = load();
    await w.fire("install");
    const res = await w.fire("fetch", w.req("/", "navigate"));
    expect(await res!.text()).toBe(`net:${ORIGIN}/`);
  });

  it("serves stored files from the cache", async () => {
    const w = load();
    await w.fire("install");
    const before = w.calls.fetched.length;
    const res = await w.fire("fetch", w.req("/assets/app.js"));
    expect(await res!.text()).toBe(`net:${ORIGIN}/assets/app.js`);
    expect(w.calls.fetched.length).toBe(before);
  });

  it("leaves API calls, gateway pages and other origins alone", async () => {
    const w = load();
    await w.fire("install");
    for (const e of [
      w.req("/api/caches?bbox=1,2,3,4"),
      w.req("/auth/email/verify?token=x", "navigate"),
      w.req("/source", "navigate"),
      { request: new Request("https://tiles.example/1/2/3.pbf") },
      { request: new Request(ORIGIN + "/api/caches/1/logs", { method: "POST", body: "{}" }) },
    ])
      expect(await w.fire("fetch", e)).toBeUndefined();
  });
});

describe("Web Push", () => {
  it("shows a notification on push, with the payload when there is one", async () => {
    const w = load();
    await w.fire("push", { data: { json: () => ({ title: "Watch", body: "OE8APR found AC-1" }) } });
    await w.fire("push", {});
    expect(w.calls.notifications).toMatchObject([
      { title: "Watch", body: "OE8APR found AC-1", tag: "acs-watch" },
      { title: "APRScaching" },
    ]);
  });

  it("focuses the app on a notification click", async () => {
    const w = load();
    let closed = false;
    await w.fire("notificationclick", { notification: { close: () => (closed = true) } });
    expect(closed).toBe(true);
    expect(w.calls.focused).toBe(1);
  });
});

describe("Background Sync of the offline log queue", () => {
  const API = "https://api.example";
  const item = (cacheId: number, instance?: string, extra: Record<string, unknown> = {}) => ({
    cacheId,
    body: { logType: "found", comment: `c${cacheId}` },
    queuedAt: 1000 + cacheId,
    ...(instance && { instance }),
    ...extra,
  });
  async function seed(queue: unknown[]) {
    const st = idbStore();
    await st.kvSet("acs.sync.apiBase", API);
    await st.kvSet("acs.sync.instance", "here.example");
    await st.kvSet("acs.logqueue", JSON.stringify(queue));
    await st.kvSet("acs.logqueue.attention", "[]");
    return st;
  }

  it("sends what is due to the instance it was signed for, files refusals, backs off server errors", async () => {
    const st = await seed([
      item(1, "here.example"),
      item(2, "here.example"),
      item(3, "here.example"),
      item(4, "there.example"),
    ]);
    const posted: { url: string; body: unknown }[] = [];
    const w = load({
      net: (url, init) => {
        posted.push({ url, body: JSON.parse(String(init?.body)) });
        if (url.endsWith("/2/logs")) return Response.json({ error: "no such cache" }, { status: 404 });
        if (url.endsWith("/3/logs")) return new Response("busy", { status: 503 });
        return Response.json({ logged: true });
      },
    });
    await w.fire("sync", { tag: "acs-logqueue" });
    expect(posted.map((p) => p.url)).toEqual([
      `${API}/api/caches/1/logs`,
      `${API}/api/caches/2/logs`,
      `${API}/api/caches/3/logs`,
    ]);
    expect(posted[0]!.body).toEqual({ logType: "found", comment: "c1", offline: true });
    const queue = JSON.parse((await st.kvGet("acs.logqueue"))!) as { cacheId: number; attempts?: number }[];
    expect(queue.map((q) => q.cacheId)).toEqual([3, 4]);
    expect(queue[0]!.attempts).toBe(1);
    const attention = JSON.parse((await st.kvGet("acs.logqueue.attention"))!) as { cacheId: number; reason: string }[];
    expect(attention).toMatchObject([{ cacheId: 2, reason: "no such cache", status: 404 }]);
    expect(w.calls.messages).toEqual([{ type: "acs-queued" }]);
  });

  it("keeps everything and fails the sync while the instance cannot be reached, so the browser retries", async () => {
    const st = await seed([item(5, "here.example")]);
    const w = load({ net: () => Promise.reject(new TypeError("offline")) });
    await expect(w.fire("sync", { tag: "acs-logqueue" })).rejects.toThrow(/not reachable/);
    expect(JSON.parse((await st.kvGet("acs.logqueue"))!)).toHaveLength(1);
  });

  it("confirms a stage unlocked offline at its unlock endpoint, with the scanned code", async () => {
    const st = await seed([
      {
        cacheId: 7,
        kind: "unlock",
        stageNo: 2,
        body: { logType: "unlock", loggerCall: "OE8FND", code: "k7m2q9x4w8" },
        queuedAt: 9,
        instance: "here.example",
      },
    ]);
    const posted: { url: string; body: unknown }[] = [];
    const w = load({
      net: (url, init) => {
        posted.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ unlocked: true });
      },
    });
    await w.fire("sync", { tag: "acs-logqueue" });
    expect(posted).toEqual([
      { url: `${API}/api/caches/7/stages/2/unlock`, body: { callsign: "OE8FND", code: "k7m2q9x4w8" } },
    ]);
    expect(JSON.parse((await st.kvGet("acs.logqueue"))!)).toEqual([]);
  });

  it("ignores other sync tags", async () => {
    await seed([item(6, "here.example")]);
    const w = load();
    expect(await w.fire("sync", { tag: "something-else" })).toBeUndefined();
    expect(w.calls.fetched).toEqual([]);
  });
});
