// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { ApiError, getSession, logout, logoutAll, type Session } from "../api.js";
import { forgetSession, recallSession, rememberSession, type SessionStore } from "./sessionMemory.js";
import { disablePush } from "../push.js";

const store: SessionStore = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
};

/**
 * The signed-in session: identity comes from the server cookie. Without a connection the app falls back
 * to the last session it saw (sessionMemory.ts), marked `offline`, and asks again when the connection
 * returns.
 */
export function useSession() {
  const [s, setS] = useState<Session>({ callsign: null });
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const fresh = await getSession();
      rememberSession(store, fresh);
      setS(fresh);
      setOffline(false);
    } catch (e) {
      // the server answered (an error status): that is no session; no answer at all: the remembered one
      const remembered = e instanceof ApiError ? null : recallSession(store);
      setS(remembered ?? { callsign: null });
      setOffline(remembered != null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const online = () => void refresh();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [refresh]);
  // This browser's push subscription delivers the signed-in account's alerts, so it ends with the session:
  // removed from the gateway while the session still authorises that, then unsubscribed in the browser.
  const signOut = useCallback(async () => {
    await disablePush().catch(() => {});
    await logout().catch(() => {});
    forgetSession(store);
    setS({ callsign: null });
  }, []);
  /**
   * The person has read why their session ended: the dead cookie goes, so the notice does not come back. No push
   * subscription is touched — it ended with the session on the gateway.
   */
  const dismissEnded = useCallback(async () => {
    setS((cur) => ({ ...cur, ended: undefined }));
    await logout().catch(() => {});
  }, []);
  /** Sign out on every device; throws when the server refused, so the caller can say so. */
  const signOutEverywhere = useCallback(async () => {
    await disablePush().catch(() => {});
    await logoutAll();
    forgetSession(store);
    setS({ callsign: null });
  }, []);
  return {
    callsign: s.callsign ?? "",
    verified: !!s.verified,
    email: s.email ?? null,
    pendingEmail: s.pendingEmail ?? null,
    /** The account's passkey count, when the gateway said (useful with `email` to tell if it can sign in again). */
    passkeys: s.passkeys,
    signedIn: !!s.callsign,
    /** Signed out: why the session this browser held ended (a suspension, a callsign released). */
    ended: s.callsign ? undefined : s.ended,
    dismissEnded,
    /** The session opens only the data of an account that holds no callsign (AccountData). */
    accountData: !s.callsign && !!s.accountData,
    /** The session is the remembered one: the app has no connection to its instance. */
    offline,
    loading,
    refresh,
    signOut,
    signOutEverywhere,
  };
}

/** The value returned by `useSession` — passed down to the lazily-loaded Platform. */
export type SessionState = ReturnType<typeof useSession>;
