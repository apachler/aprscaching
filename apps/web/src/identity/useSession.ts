// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { getSession, logout, logoutAll, type Session } from "../api.js";

/** The signed-in session: identity comes from the server cookie, not localStorage. */
export function useSession() {
  const [s, setS] = useState<Session>({ callsign: null });
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setS(await getSession());
    } catch {
      setS({ callsign: null });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const signOut = useCallback(async () => {
    await logout().catch(() => {});
    setS({ callsign: null });
  }, []);
  /** Sign out on every device; throws when the server refused, so the caller can say so. */
  const signOutEverywhere = useCallback(async () => {
    await logoutAll();
    setS({ callsign: null });
  }, []);
  return {
    callsign: s.callsign ?? "",
    verified: !!s.verified,
    email: s.email ?? null,
    signedIn: !!s.callsign,
    loading,
    refresh,
    signOut,
    signOutEverywhere,
  };
}

/** The value returned by `useSession` — passed down to the lazily-loaded Platform. */
export type SessionState = ReturnType<typeof useSession>;
