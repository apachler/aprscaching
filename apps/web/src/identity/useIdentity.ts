import { useCallback, useState } from "react";

/**
 * Operating identity (M9 Phase 1): a person operates one or more callsigns (incl. APRS SSIDs like
 * OE8APR-9) with one ACTIVE at a time. Persisted in localStorage until the account backend (passkey
 * + account_id) lands; the shape maps onto account_callsigns/account_stations later. Verification is
 * per BASE call (the license) — SSIDs inherit it.
 */
const KEY = "acs.identity";
const LEGACY = "acs.call";

export type Identity = { list: string[]; active: string };

/** Strip the SSID to the licensed base call (OE8APR-9 -> OE8APR). */
export function baseCall(c: string): string { return c.toUpperCase().split("-")[0] ?? ""; }
function norm(c: string): string { return c.toUpperCase().trim(); }

function load(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw) as Identity; if (Array.isArray(s.list)) return { list: s.list, active: s.active || s.list[0] || "" }; }
  } catch { /* fall through */ }
  const legacy = localStorage.getItem(LEGACY) ?? "";
  return { list: legacy ? [legacy] : [], active: legacy };
}

export function useIdentity() {
  const [st, setSt] = useState<Identity>(load);
  const persist = useCallback((next: Identity) => {
    setSt(next);
    localStorage.setItem(KEY, JSON.stringify(next));
    if (next.active) localStorage.setItem(LEGACY, next.active); else localStorage.removeItem(LEGACY);
  }, []);
  const add = useCallback((c: string) => {
    const cs = norm(c); if (cs.length < 3) return;
    setSt((s) => { const next = { list: s.list.includes(cs) ? s.list : [...s.list, cs], active: s.active || cs };
      localStorage.setItem(KEY, JSON.stringify(next)); localStorage.setItem(LEGACY, next.active); return next; });
  }, []);
  const setActive = useCallback((c: string) => {
    const cs = norm(c);
    setSt((s) => { const next = { list: s.list.includes(cs) ? s.list : [...s.list, cs], active: cs };
      localStorage.setItem(KEY, JSON.stringify(next)); localStorage.setItem(LEGACY, cs); return next; });
  }, []);
  const remove = useCallback((c: string) => {
    setSt((s) => { const list = s.list.filter((x) => x !== c); const next = { list, active: s.active === c ? (list[0] ?? "") : s.active };
      localStorage.setItem(KEY, JSON.stringify(next)); if (next.active) localStorage.setItem(LEGACY, next.active); else localStorage.removeItem(LEGACY); return next; });
  }, []);
  return { active: st.active, list: st.list, add, setActive, remove, persist };
}
