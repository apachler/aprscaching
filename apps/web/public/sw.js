// SPDX-License-Identifier: AGPL-3.0-or-later
/* aprscaching service worker — the offline app shell and Web Push.

   App shell: the build (vite-sw.ts) writes the list of files the app needs to start — the hashed
   bundles, index.html, the fonts, icons and images the app references — into PRECACHE, and a version
   into VERSION. They are stored on install in a cache named after the version, and an activated worker
   deletes the caches of older versions. Opening the app (a navigation to "/") tries the network for a
   few seconds and falls back to the stored shell; a stored file is served from the cache. Nothing else
   is touched: API calls, gateway pages (sign-in links, /source, /embed) and map tiles go to the network
   as they would without a worker. The app's own data layer keeps the data it needs offline.

   A new version waits until the user agrees (the app shows "Reload"), so it never replaces the running
   app in the middle of a hunt; the very first install activates at once.

   Background Sync: the offline log queue is sent when the connection returns, even with the app closed
   (Chromium; see "Background Sync" below).

   Push: a notification on push, and the app focused on click. Pushes are payload-less by default, so
   the body is generic; the detail lives in the in-app watchlist and the email digest. */
const VERSION = "dev";
const PRECACHE = [];
const CACHE = `acs-shell-${VERSION}`;
const SHELL = "/index.html";
/** How long opening the app waits for the network before it starts from the stored shell. */
const NAV_TIMEOUT_MS = 3000;
const PRECACHED = new Set(PRECACHE);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (PRECACHE.length) {
        const cache = await caches.open(CACHE);
        // bypass the HTTP cache, so the stored copy is the one this version was built with
        await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })));
      }
      // the first worker takes over at once; a later one waits for the user (see "message")
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("acs-shell-") && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The app posts this when the user taps Reload on the update notice.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/** Opening the app: the network when it answers in time, else the stored shell. */
async function openApp(request) {
  const network = fetch(request);
  network.catch(() => {}); // a late failure after the shell was served is expected, not an error
  const shell = await caches.match(SHELL, { cacheName: CACHE });
  if (!shell) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    return res || shell;
  } catch {
    return shell;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // only the app itself; every other page on this origin belongs to the gateway
    if (url.pathname === "/" || url.pathname === SHELL) event.respondWith(openApp(req));
    return;
  }
  if (PRECACHED.has(url.pathname))
    event.respondWith(caches.match(url.pathname, { cacheName: CACHE }).then((hit) => hit || fetch(req)));
});

// ---- Background Sync: the offline log queue -------------------------------------------------------------
/* With a connection back, the browser wakes the worker (tag "acs-logqueue", Chromium) even with the app
   closed. The worker sends the queued logs the way the app does (src/log/logQueue.ts): each to the instance
   it was signed for, a server error backed off, a refusal moved to needs-attention, never dropped. It takes
   the same lock as the app, so the two never send a log at once, and tells open pages the queue changed. */
const OFFLINE_DB = "acs-offline";

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(OFFLINE_DB);
    // the app creates the database; a worker finding none has nothing to send and must not create it
    r.onupgradeneeded = () => r.transaction.abort();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kvGet(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}
async function kvSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
const backoffMs = (attempts) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);

async function flushQueue() {
  let db;
  try {
    db = await openOfflineDb();
  } catch {
    return;
  }
  const apiBase = await kvGet(db, "acs.sync.apiBase");
  const instance = await kvGet(db, "acs.sync.instance");
  const queue = JSON.parse((await kvGet(db, "acs.logqueue")) || "[]");
  if (!apiBase || !queue.length) return;
  const keep = [];
  const refused = [];
  const now = Date.now();
  let offline = false;
  for (const item of queue) {
    const elsewhere = instance && item.instance && item.instance !== instance;
    if (offline || elsewhere || (item.nextAt != null && item.nextAt > now)) {
      keep.push(item);
      continue;
    }
    // a stage unlocked offline is confirmed at its unlock endpoint; a log is posted to the logbook
    const unlock = item.kind === "unlock";
    let res;
    try {
      res = await fetch(
        unlock
          ? `${apiBase}/api/caches/${item.cacheId}/stages/${item.stageNo}/unlock`
          : `${apiBase}/api/caches/${item.cacheId}/logs`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            unlock ? { callsign: item.body.loggerCall, code: item.body.code } : { ...item.body, offline: true },
          ),
        },
      );
    } catch {
      offline = true;
      keep.push(item);
      continue;
    }
    if (res.ok) continue;
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      const attempts = (item.attempts ?? 0) + 1;
      keep.push({ ...item, attempts, nextAt: now + backoffMs(attempts) });
    } else {
      const body = await res.json().catch(() => ({}));
      const { nextAt: _n, attempts: _a, ...rest } = item;
      refused.push({ ...rest, reason: body.error || `${res.status}`, status: res.status, refusedAt: now });
    }
  }
  // a log queued while this flush was sending is kept too
  const latest = JSON.parse((await kvGet(db, "acs.logqueue")) || "[]");
  const added = latest.filter((q) => !queue.some((o) => o.queuedAt === q.queuedAt && o.cacheId === q.cacheId));
  await kvSet(db, "acs.logqueue", JSON.stringify([...keep, ...added]));
  if (refused.length) {
    const attention = JSON.parse((await kvGet(db, "acs.logqueue.attention")) || "[]");
    await kvSet(db, "acs.logqueue.attention", JSON.stringify([...attention, ...refused]));
  }
  for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
    c.postMessage({ type: "acs-queued" });
  // still no connection: failing the sync makes the browser try it again later
  if (offline) throw new Error("the instance is not reachable yet");
}

self.addEventListener("sync", (event) => {
  if (event.tag !== "acs-logqueue") return;
  const locks = self.navigator && self.navigator.locks;
  event.waitUntil(locks ? locks.request("acs-logqueue", flushQueue) : flushQueue());
});

self.addEventListener("push", (event) => {
  let title = "APRScaching";
  let body = "New watchlist activity — open the app to see what's active.";
  try {
    if (event.data) {
      const d = event.data.json();
      title = d.title || title;
      body = d.body || body;
    }
  } catch (e) {
    /* payload-less push */
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/manifest-icon-192.png",
      badge: "/icons/favicon-96x96.png",
      tag: "acs-watch",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = wins.find((w) => "focus" in w);
      if (open) return open.focus();
      return self.clients.openWindow("/");
    })(),
  );
});
