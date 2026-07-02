// SPDX-License-Identifier: AGPL-3.0-or-later
/* aprscaching service worker — Web Push (ADR-4b). Push-only (no fetch/caching): it shows a
   notification on push and focuses the app on click. Pushes are payload-less by default, so the
   body is generic; the detail lives in the in-app watchlist + the email digest. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let title = "APRScaching";
  let body = "New watchlist activity — open the app to see what's active.";
  try { if (event.data) { const d = event.data.json(); title = d.title || title; body = d.body || body; } } catch (e) { /* payload-less push */ }
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icons/manifest-icon-192.png",
    badge: "/icons/favicon-96x96.png",
    tag: "acs-watch",
    renotify: true,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((w) => "focus" in w);
    if (open) return open.focus();
    return self.clients.openWindow("/");
  })());
});
