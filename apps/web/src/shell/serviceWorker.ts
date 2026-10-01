// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The service worker from the app's side: register it on start (production builds; the worker stores the
 * app shell so the app opens offline, public/sw.js), and tell the app when a new version is ready. The new
 * version waits until the user takes it with {@link applyUpdate}, so it never replaces the running app in
 * the middle of a hunt. push.ts registers the same worker for Web Push.
 */

/** Fired on window when a new version has been stored and waits for the user. */
export const UPDATE_EVENT = "acs-sw-update";

let waiting: ServiceWorker | null = null;

function announce(worker: ServiceWorker) {
  waiting = worker;
  window.dispatchEvent(new Event(UPDATE_EVENT));
}

/** Register the worker and watch for new versions. A browser without service workers simply has none. */
export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register("/sw.js");
  } catch {
    return;
  }
  // a version stored while the app was closed waits already; an update replacing a worker that controls
  // this page is announced once it is installed (the very first install takes over at once instead)
  if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const next = reg.installing;
    next?.addEventListener("statechange", () => {
      if (next.state === "installed" && navigator.serviceWorker.controller) announce(next);
    });
  });
  // look for a new version when the app comes back to the foreground, not only on a full load
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reg.update().catch(() => {});
  });
}

/** Is a new version waiting for the user? */
export const updateWaiting = (): boolean => waiting != null;

/** Take the waiting version: it activates, and the page reloads onto it. */
export function applyUpdate(): void {
  if (!waiting) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  waiting.postMessage({ type: "SKIP_WAITING" });
}
