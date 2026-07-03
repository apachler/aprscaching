// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Toast — transient, non-blocking confirmation (ui-ux.md §3, §7). A provider holds the queue and
 * exposes useToast(); the live region is announced to assistive tech. The entrance animates
 * transform/opacity only and is removed under prefers-reduced-motion (styles.css).
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

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
