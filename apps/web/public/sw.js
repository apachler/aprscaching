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
