// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * toolOwner.ts — whose installed tools this browser holds. Installed tools carry their approvals (transmit
 * included) and follow an account, so they belong to one identity: the signed-in callsign, or the guest (""). When
 * the identity changes (a sign-out, another account on a shared computer), every running tool stops, its beacon
 * ends, and the stored installs are cleared before the next identity's own come in; nothing installed under one
 * identity ever reaches another, nor seeds another account's settings. Kept small: the platform imports it at
 * start-up, and the sandbox code loads only when there are tools to run.
 */
import { INSTALLED_KEY } from "./installedRecords.js";

export const OWNER_KEY = "acs.tools.owner";

let current: string | null = null;
const stoppers = new Set<() => void>();

/** The identity this page's tools belong to, or null before the session is known. */
export const toolOwner = (): string | null => current;

/** Run `fn` when the identity changes, to stop what runs for the previous one. */
export function onToolOwnerChange(fn: () => void): void {
  stoppers.add(fn);
}

/**
 * Claim the installed tools for the session's identity (`callsign`, "" signed out). True when the identity changed:
 * the running tools were stopped and the stored installs cleared.
 */
export function claimTools(callsign: string): boolean {
  const who = callsign.toUpperCase();
  current = who;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(OWNER_KEY);
  } catch {
    /* storage blocked: nothing stored to clear */
  }
  if (stored === who) return false;
  for (const fn of stoppers) fn();
  try {
    localStorage.removeItem(INSTALLED_KEY);
    localStorage.setItem(OWNER_KEY, who);
  } catch {
    /* storage blocked */
  }
  return true;
}

/** The stored installs belong to `callsign` (the account the settings sync is about to write into). */
export function toolsOwnedBy(callsign: string): boolean {
  try {
    return localStorage.getItem(OWNER_KEY) === callsign.toUpperCase();
  } catch {
    return false;
  }
}
