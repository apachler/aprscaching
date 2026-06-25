import { useCallback, useState } from "react";

/** Callsign identity, persisted in localStorage (until passkey sessions land). */
export function useCallsign(): [string, (v: string) => void] {
  const [call, setCall] = useState(() => localStorage.getItem("acs.call") ?? "");
  const set = useCallback((v: string) => {
    const cs = v.toUpperCase().trim();
    setCall(cs);
    if (cs) localStorage.setItem("acs.call", cs); else localStorage.removeItem("acs.call");
  }, []);
  return [call, set];
}
