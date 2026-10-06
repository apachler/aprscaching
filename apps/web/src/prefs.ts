// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * prefs.ts (client) — sync the device-independent UI preferences to the signed-in account so a second
 * device restores them. The prefs themselves live in localStorage (single source of truth
 * for the app); this layer mirrors a known subset to the account on change, and pulls them back on
 * sign-in. Guests are unaffected — the server endpoint is session-gated, so a 401 just leaves the
 * localStorage values in place. Synced keys: locale/units/theme, pinned apps, basemap, installed tools.
 */
import { getPrefs, putPrefs, type AccountPrefs } from "./api.js";
import { toolsOwnedBy } from "./tools/toolOwner.js";
import { TOAST_EVENT } from "./ui/Toast.js";

/** pref-name → localStorage key. Each value is stored JSON-encoded under its localStorage key. */
const SYNCED: Record<string, string> = {
  locale: "acs.locale", // format.ts LocaleSettings (theme, units, locale, timeZone)
  pins: "acs.pins", // pinned shack app ids
  basemap: "acs.basemap", // basemap choice
  tools: "acs.tools", // installed tools (tools/installed.ts)
};

/** Set true once a session-authenticated GET succeeds; gates pushes so guests never call the API. */
let sessionActive = false;

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

/**
 * Snapshot the synced localStorage values into a prefs object for the server. `seed` leaves the installed tools
 * out: an account's tools come only from installs made while it was signed in, never from what this browser held.
 */
function collectLocalPrefs(seed = false): AccountPrefs {
  const out: AccountPrefs = {};
  for (const [name, key] of Object.entries(SYNCED)) {
    if (seed && name === "tools") continue;
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
export async function pullPrefs(callsign: string): Promise<void> {
  let prefs: AccountPrefs;
  try {
    ({ prefs } = await getPrefs());
  } catch {
    sessionActive = false;
    return;
  } // not signed in (401) or offline → keep local values
  sessionActive = true;

  if (Object.keys(prefs).length === 0) {
    pushPrefs(true);
    return;
  } // seed the account from this device, its installed tools left out

  let changed = false;
  for (const [name, key] of Object.entries(SYNCED)) {
    if (prefs[name] === undefined) continue;
    // the account's tools go only where this account owns the installs (a sign-out meanwhile cleared them)
    if (name === "tools" && !toolsOwnedBy(callsign)) continue;
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

/** Push the current local prefs to the account (only when a session is active); say so when the account refuses. */
function pushPrefs(seed = false): void {
  if (!sessionActive) return;
  putPrefs(collectLocalPrefs(seed)).catch((e: unknown) => {
    // localStorage remains the source of truth; the person learns their other devices won't see this change
    try {
      window.dispatchEvent(
        new CustomEvent(TOAST_EVENT, {
          detail: `Couldn't save your settings to your account (${(e as Error).message || "error"}); they stay on this device.`,
        }),
      );
    } catch {
      /* SSR */
    }
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
