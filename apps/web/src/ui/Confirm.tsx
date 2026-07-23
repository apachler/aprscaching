// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Confirm — the one confirmation dialog (ui-ux.md §3: Dialog for a focused decision; §1.8:
 * destructive actions confirm, and every path is cancellable). Replaces window.confirm so
 * confirmations are themed, focus-trapped, and can present a real choice set. A provider holds the
 * pending request; useConfirm() resolves true/false, useChoice() resolves the picked value or null
 * on cancel/Escape — cancel never commits anything.
 */
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useModalDialog } from "./useModalDialog.js";

export interface ConfirmOpts {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the primary as destructive (red). */
  danger?: boolean;
}
export interface ChoiceOpts {
  title?: string;
  message: ReactNode;
  choices: { label: string; value: string; primary?: boolean; danger?: boolean }[];
  cancelLabel?: string;
}

type Pending =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (ok: boolean) => void }
  | { kind: "choice"; opts: ChoiceOpts; resolve: (value: string | null) => void };

const Ctx = createContext<{
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  choose: (opts: ChoiceOpts) => Promise<string | null>;
}>({
  confirm: () => Promise.resolve(false),
  choose: () => Promise.resolve(null),
});

export function ConfirmProvider(props: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const api = useRef({
    confirm: (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ kind: "confirm", opts, resolve })),
    choose: (opts: ChoiceOpts) =>
      new Promise<string | null>((resolve) => setPending({ kind: "choice", opts, resolve })),
  });
  const settle = (value: boolean | string | null) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(value === true);
    else pending.resolve(typeof value === "string" ? value : null);
    setPending(null);
  };
  return (
    <Ctx.Provider value={api.current}>
      {props.children}
      {pending && <ConfirmDialog pending={pending} onSettle={settle} />}
    </Ctx.Provider>
  );
}

function ConfirmDialog(props: { pending: Pending; onSettle: (v: boolean | string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalDialog(ref, () => props.onSettle(null));
  const { pending } = props;
  const title = pending.opts.title ?? "Are you sure?";
  return (
    <div className="confirm-backdrop" onClick={() => props.onSettle(null)}>
      <div
        ref={ref}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        <div className="confirm-body">{pending.opts.message}</div>
        <div className="row confirm-actions">
          {pending.kind === "confirm" ? (
            <button className={pending.opts.danger ? "primary danger" : "primary"} onClick={() => props.onSettle(true)}>
              {pending.opts.confirmLabel ?? "Confirm"}
            </button>
          ) : (
            pending.opts.choices.map((c) => (
              <button
                key={c.value}
                className={
                  [c.primary ? "primary" : "", c.danger ? "danger" : ""].filter(Boolean).join(" ") || undefined
                }
                onClick={() => props.onSettle(c.value)}
              >
                {c.label}
              </button>
            ))
          )}
          <button onClick={() => props.onSettle(null)}>{pending.opts.cancelLabel ?? "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}

/** Themed, focus-trapped yes/no confirmation. Resolves false on cancel, Escape, or backdrop. */
export function useConfirm() {
  return useContext(Ctx).confirm;
}
/** Themed multi-way decision. Resolves the picked value, or null on cancel — never a default. */
export function useChoice() {
  return useContext(Ctx).choose;
}
