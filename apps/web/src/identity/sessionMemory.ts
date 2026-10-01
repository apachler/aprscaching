// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The last signed-in session, remembered on the device so the app opened without a connection still
 * knows whose finds it logs. It only labels the app: the server decides every request by its session
 * cookie, so a log queued under a remembered call is accepted only if that session is still valid when it
 * syncs. A server answer always wins — "signed out" forgets the memory — and only a failed connection
 * falls back to it. Only the callsign and whether it is verified are kept.
 */
import type { Session } from "../api.js";

export interface SessionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const KEY = "acs.session";

export function rememberSession(store: SessionStore, s: Session): void {
  try {
    if (s.callsign) store.set(KEY, JSON.stringify({ callsign: s.callsign, verified: !!s.verified }));
    else store.remove(KEY);
  } catch {
    /* storage unavailable: nothing remembered */
  }
}

export function forgetSession(store: SessionStore): void {
  try {
    store.remove(KEY);
  } catch {
    /* nothing to forget */
  }
}

export function recallSession(store: SessionStore): Session | null {
  try {
    const v = JSON.parse(store.get(KEY) ?? "null") as { callsign?: unknown; verified?: unknown } | null;
    return v && typeof v.callsign === "string" ? { callsign: v.callsign, verified: v.verified === true } : null;
  } catch {
    return null;
  }
}
