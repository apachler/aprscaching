// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pure parts of what the app tells a person about their own account: why a session ended, whether the
 * account has a way back in besides the session it is using, and where a sign-in returns to.
 */
import type { SessionEnded } from "../api.js";

/** The notice for a session that ended: its title, its text, and the next step it offers. */
interface EndedNotice {
  title: string;
  body: string;
  /** `data`: get or erase the data of an account that holds no callsign; `signin`: sign in again. */
  action: "data" | "signin" | null;
}

/** What to say when a session ended for a reason the gateway gives (`/auth/session`'s `ended`). */
export function endedNotice(e: SessionEnded, day: (unixS: number) => string): EndedNotice {
  if (e.reason === "suspended")
    return {
      title: "Your account is suspended",
      body: `This account is suspended ${e.until ? `until ${day(e.until)}` : "until the sysop lifts it"}: ${e.why.replace(/[.!?]$/, "")}. While the suspension holds, you cannot sign in on this instance.`,
      action: null,
    };
  const how =
    e.by === "licensee"
      ? `Your callsign ${e.callsign} was taken over by its verified holder.`
      : `The sysop released your callsign ${e.callsign} from your account${e.note ? `: ${e.note}` : ""}.`;
  return e.callless
    ? {
        title: `${e.callsign} is no longer yours`,
        body: `${how} Your account keeps your finds and caches but holds no callsign now. Get a copy of your data or erase it, or sign in with the callsign you operate now.`,
        action: "data",
      }
    : {
        title: `${e.callsign} is no longer yours`,
        body: `${how} Your account keeps its other callsigns and everything you logged: sign in again with one of them.`,
        action: "signin",
      };
}

/**
 * Has the signed-in account no way back in once this session ends: no passkey and no confirmed email? An
 * address still waiting for confirmation is no way in yet. Unknown (an older or remembered session) is no.
 */
export function needsRecovery(s: {
  signedIn: boolean;
  offline: boolean;
  passkeys?: number;
  email: string | null;
}): boolean {
  return s.signedIn && !s.offline && s.passkeys === 0 && !s.email;
}

/** The slice of Storage a sign-in's return point lives in. */
export interface ReturnStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const RETURN_KEY = "acs.signin.return";
/** A sign-in started from a cache returns there within this long: an email link may take a while to arrive. */
const RETURN_TTL_MS = 30 * 60_000;

/**
 * Remember the cache a sign-in started from, so the app returns to it once the person is signed in — in this
 * page after a passkey, or in the page an email link opens. Storage may be refused; the sign-in still works.
 */
export function rememberReturn(store: ReturnStore, cacheId: number, now = Date.now()): void {
  try {
    store.setItem(RETURN_KEY, JSON.stringify({ cacheId, at: now }));
  } catch {
    /* storage refused: the sign-in returns to the map */
  }
}

/** The cache a sign-in started from, once: the record is removed, and one older than its lifetime is ignored. */
export function takeReturn(store: ReturnStore, now = Date.now()): number | null {
  try {
    const raw = store.getItem(RETURN_KEY);
    if (raw === null) return null;
    store.removeItem(RETURN_KEY);
    const v = JSON.parse(raw) as { cacheId?: unknown; at?: unknown };
    return typeof v.cacheId === "number" && typeof v.at === "number" && now - v.at <= RETURN_TTL_MS && now >= v.at
      ? v.cacheId
      : null;
  } catch {
    return null;
  }
}
