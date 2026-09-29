// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Toast — transient, non-blocking confirmation (ui-ux.md §3, §7). A provider holds the queue and
 * exposes useToast(); the live region is announced to assistive tech. The entrance animates
 * transform/opacity only and is removed under prefers-reduced-motion (styles/components/toast.css).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A window event whose `detail` string is shown as a toast. Code outside React (the shared tool host's
 * beacon/TX feedback) raises toasts through it; the provider listens for the life of the app, so the
 * feedback shows whichever surface is open.
 */
export const TOAST_EVENT = "acs:toast";

type ToastItem = { id: number; msg: string };
const ToastCtx = createContext<(msg: string) => void>(() => {});

export function ToastProvider(props: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const push = useCallback((msg: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);
  useEffect(() => {
    const h = (e: Event) => {
      const msg = (e as CustomEvent<unknown>).detail;
      if (typeof msg === "string" && msg) push(msg);
    };
    window.addEventListener(TOAST_EVENT, h);
    return () => window.removeEventListener(TOAST_EVENT, h);
  }, [push]);
  return (
    <ToastCtx.Provider value={push}>
      {props.children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Returns push(msg) — fire-and-forget transient confirmation. */
export function useToast() {
  return useContext(ToastCtx);
}
