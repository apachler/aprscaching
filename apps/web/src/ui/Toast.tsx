// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Toast — transient, non-blocking feedback (ui-ux.md §3, §7). A provider holds the queue and exposes useToast(); the
 * live regions are announced to assistive tech. A confirmation stays long enough to read at its length and waits
 * while the pointer or focus is on the stack; an error stays until it is dismissed (WCAG 2.2.1), since it says what
 * went wrong and how to fix it. Every toast has a close button. The entrance animates transform/opacity only and is
 * removed under prefers-reduced-motion (styles/components/toast.css).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button.js";
import { Icon } from "./Icon.js";

/**
 * A window event whose `detail` string is shown as a toast. Code outside React (the shared tool host's
 * beacon/TX feedback) raises toasts through it; the provider listens for the life of the app, so the
 * feedback shows whichever surface is open.
 */
export const TOAST_EVENT = "acs:toast";

export type ToastOptions = {
  /** A failure: announced at once, and kept until it is dismissed. */
  kind?: "error";
};
type ToastItem = { id: number; msg: string; kind?: "error" };
type Push = (msg: string, opts?: ToastOptions) => void;
const ToastCtx = createContext<Push>(() => {});

/** How long a confirmation stays: long enough to read at its length, never under five seconds. */
export function toastDuration(msg: string): number {
  return Math.max(5000, 2000 + msg.length * 60);
}

export function ToastProvider(props: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const list = useRef(toasts);
  list.current = toasts;
  const stack = useRef<HTMLDivElement>(null);
  // the pointer or focus on the stack holds every confirmation in it
  const on = useRef({ pointer: false, focus: false });
  const held = () => on.current.pointer || on.current.focus;

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const schedule = useCallback(
    (t: ToastItem) => {
      if (t.kind === "error" || held()) return;
      timers.current.set(
        t.id,
        setTimeout(() => dismiss(t.id), toastDuration(t.msg)),
      );
    },
    [dismiss],
  );
  const push = useCallback<Push>(
    (msg, opts) => {
      const t: ToastItem = { id: nextId.current++, msg, kind: opts?.kind };
      setToasts((all) => [...all, t]);
      schedule(t);
    },
    [schedule],
  );

  const hold = useCallback((what: "pointer" | "focus") => {
    on.current[what] = true;
    for (const h of timers.current.values()) clearTimeout(h);
    timers.current.clear();
  }, []);
  // once neither the pointer nor focus is on the stack, each confirmation gets its full time again
  const release = useCallback(
    (what: "pointer" | "focus") => {
      if (!on.current[what]) return;
      on.current[what] = false;
      if (!held()) for (const t of list.current) schedule(t);
    },
    [schedule],
  );
  // a dismissed toast takes its focused close button with it, and a removed element sends no blur
  useEffect(() => {
    if (on.current.focus && !stack.current?.contains(document.activeElement)) release("focus");
  }, [toasts, release]);

  useEffect(() => {
    const h = (e: Event) => {
      const msg = (e as CustomEvent<unknown>).detail;
      if (typeof msg === "string" && msg) push(msg);
    };
    window.addEventListener(TOAST_EVENT, h);
    return () => window.removeEventListener(TOAST_EVENT, h);
  }, [push]);
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const h of all.values()) clearTimeout(h);
    };
  }, []);

  const item = (t: ToastItem) => (
    <div key={t.id} className={`toast${t.kind === "error" ? " toast-error" : ""}`}>
      <span className="toast-msg">{t.msg}</span>
      <Button variant="icon-subtle" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
        <Icon name="close" size={14} cp437="×" />
      </Button>
    </div>
  );
  return (
    <ToastCtx.Provider value={push}>
      {props.children}
      <div
        ref={stack}
        className="toasts"
        onPointerEnter={() => hold("pointer")}
        onPointerLeave={() => release("pointer")}
        onFocus={() => hold("focus")}
        onBlur={(e) => {
          // focus moving between the stack's own buttons keeps it held
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release("focus");
        }}
      >
        <div className="toast-region" role="alert">
          {toasts.filter((t) => t.kind === "error").map(item)}
        </div>
        <div className="toast-region" role="status" aria-live="polite">
          {toasts.filter((t) => t.kind !== "error").map(item)}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}

/** Returns push(msg, opts) — fire-and-forget feedback; `{ kind: "error" }` for a failure the reader must see. */
export function useToast() {
  return useContext(ToastCtx);
}
