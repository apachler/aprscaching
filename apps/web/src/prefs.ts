// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * prefs.ts (client) — sync the device-independent UI preferences to the signed-in account so a second
 * device restores them. The prefs themselves live in localStorage (single source of truth
 * for the app); this layer mirrors a known subset to the account on change, and pulls them back on
 * sign-in. Guests are unaffected — the server endpoint is session-gated, so a 401 just leaves the
 * localStorage values in place. Synced keys: locale/units/theme, pinned apps, basemap.
 */
import { getPrefs, putPrefs, type AccountPrefs } from "./api.js";

/** pref-name → localStorage key. Each value is stored JSON-encoded under its localStorage key. */
const SYNCED: Record<string, string> = {
  locale: "acs.locale", // format.ts LocaleSettings (theme, units, locale, timeZone)
  pins: "acs.pins", // pinned shack app ids
  basemap: "acs.basemap", // basemap choice
};

/** Set true once a session-authenticated GET succeeds; gates pushes so guests never call the API. */
let sessionActive = false;
export const prefsSessionActive = (): boolean => sessionActive;

/** Fired after a pull rewrites localStorage, so live components (settings, pinned rail) re-read. */
export const PREFS_EVENT = "acs:prefs-synced";

function readLocal(k: string): unknown | undefined {
  try {
    const v = localStorage.getItem(k);
    return v == null ? undefined : JSON.parse(v);
  } catch {
    return undefined;
  }
}

/** Snapshot the synced localStorage values into a prefs object for the server. */
export function collectLocalPrefs(): AccountPrefs {
  const out: AccountPrefs = {};
  for (const [name, key] of Object.entries(SYNCED)) {
    const v = readLocal(key);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * On sign-in: pull the account's prefs and write them into localStorage. If the account has no stored
 * prefs yet (first device), seed the record from what's local. Dispatches PREFS_EVENT when it changed
 * something so live components re-read. Returns silently for guests (401).
 */
export async function pullPrefs(): Promise<void> {
  let prefs: AccountPrefs;
  try {
    ({ prefs } = await getPrefs());
  } catch {
    sessionActive = false;
    return;
  } // not signed in (401) or offline → keep local values
  sessionActive = true;

  if (Object.keys(prefs).length === 0) {
    void pushPrefs();
    return;
  } // seed the account from this device

  let changed = false;
  for (const [name, key] of Object.entries(SYNCED)) {
    if (prefs[name] === undefined) continue;
    const next = JSON.stringify(prefs[name]);
    if (localStorage.getItem(key) !== next) {
      try {
        localStorage.setItem(key, next);
        changed = true;
      } catch {
        /* ignore */
      }
    }
  }
  if (changed) {
    try {
      window.dispatchEvent(new Event(PREFS_EVENT));
    } catch {
      /* ignore */
    }
  }
}

/** Push the current local prefs to the account (only when a session is active). */
export function pushPrefs(): void {
  if (!sessionActive) return;
  putPrefs(collectLocalPrefs()).catch(() => {
    /* best-effort; localStorage remains the source of truth */
  });
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Debounced push after a local pref change. No-op for guests. */
export function notePrefChange(): void {
  if (!sessionActive) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    pushPrefs();
  }, 800);
}
