// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * push.ts — browser Web Push subscription flow (ADR-4b). Registers the service worker, asks
 * permission, subscribes with the instance VAPID key, and registers the subscription with the
 * gateway. All feature-detected and best-effort; on iOS this only works inside an installed PWA.
 */
import { getPushKey, subscribePush, unsubscribePush } from "./api.js";

export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
}

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js"); } catch { return null; }
}

/** Is there an active push subscription for this browser? */
export async function pushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(reg && (await reg.pushManager.getSubscription()));
}

/**
 * Enable push: register SW → request permission → subscribe → tell the gateway.
 * Returns a short status: "on" | "denied" | "unconfigured" | "unsupported" | "error".
 */
export async function enablePush(): Promise<"on" | "denied" | "unconfigured" | "unsupported" | "error"> {
  if (!pushSupported()) return "unsupported";
  try {
    const { key } = await getPushKey();
    if (!key) return "unconfigured";
    const reg = await registration();
    if (!reg) return "error";
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return "denied";
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource }));
    await subscribePush(sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } });
    return "on";
  } catch { return "error"; }
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) { await unsubscribePush(sub.endpoint).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
}
