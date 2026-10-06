// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * push.ts — browser Web Push subscription flow. Registers the service worker, asks
 * permission, subscribes with the instance VAPID key, and registers the subscription with the
 * gateway. All feature-detected and best-effort; on iOS this only works inside an installed PWA.
 */
import { getPushKey, subscribePush, unsubscribePush } from "./api.js";
import { fromB64u } from "./base64url.js";

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/** Is there an active push subscription for this browser? */
export async function pushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(reg && (await reg.pushManager.getSubscription()));
}

/** Where turning push on stopped, when it did not finish: each has its own cause and its own way out. */
export type PushFailure =
  | "denied" // the person or the browser blocked notifications
  | "unconfigured" // the instance has no push key
  | "unsupported" // the browser has no Web Push
  | "worker" // the service worker did not register
  | "subscribe" // the browser's push service refused the subscription
  | "network" // the instance could not be reached
  | "server"; // the instance did not save the subscription

/** Enable push: register SW → request permission → subscribe → tell the gateway. "on", or where it stopped. */
export async function enablePush(): Promise<"on" | PushFailure> {
  if (!pushSupported()) return "unsupported";
  let key: string | null;
  try {
    key = (await getPushKey()).key;
  } catch {
    return "network";
  }
  if (!key) return "unconfigured";
  const reg = await registration();
  if (!reg) return "worker";
  const perm = await Notification.requestPermission().catch(() => "denied" as const);
  if (perm !== "granted") return "denied";
  let sub: PushSubscription;
  try {
    sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) }));
  } catch {
    return "subscribe";
  }
  try {
    await subscribePush(sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } });
  } catch (e) {
    return e instanceof TypeError ? "network" : "server";
  }
  return "on";
}

/** An iPhone or iPad browser outside the installed app, where Web Push is only offered to a home-screen app. */
export function iosOutsideApp(nav: { userAgent: string; standalone?: boolean } = navigator): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) && nav.standalone !== true;
}

/** What went wrong and how to fix it, in one line, for each way turning push on can fail. */
export function pushFailureText(f: PushFailure, ios = false): string {
  switch (f) {
    case "denied":
      return "Notifications are blocked — allow them for this site in your browser settings, then try again.";
    case "unconfigured":
      return "This instance has no push set up — your sysop can turn it on. The email digest still works.";
    case "unsupported":
      return ios
        ? "On iPhone and iPad, add the app to your home screen, open it from there, then enable push."
        : "This browser has no push notifications — use the email digest, or a current Chrome, Edge or Firefox.";
    case "worker":
      return "The app's background worker did not start — reload the page and try again.";
    case "subscribe":
      return ios
        ? "Your device refused the subscription — open the app from your home screen, then try again."
        : "The browser's push service refused the subscription — check that notifications are allowed, then try again.";
    case "network":
      return "Can't reach the instance — check your connection and try again.";
    case "server":
      return "The instance did not save this device — try again in a minute.";
  }
}

/** Disable push: tell the gateway to drop this browser's subscription, then unsubscribe it here. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const sub = reg && (await reg.pushManager.getSubscription().catch(() => null));
  if (sub) {
    await unsubscribePush(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}
