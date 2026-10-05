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

/** A decision that needs words: a required reason, optionally with one pick from a set (a category). */
export interface PromptOpts {
  title: string;
  message?: ReactNode;
  /** The label of the text field. */
  label: string;
  placeholder?: string;
  /** Fewest characters the text needs; 0 makes it optional. */
  minLength?: number;
  maxLength?: number;
  /** A pick-one field shown above the text; the first option is preselected. */
  select?: { label: string; options: { value: string; label: string }[] };
  /** With `select`: the picks that need the text. Others take it as optional. */
  textRequiredFor?: string[];
  confirmLabel?: string;
  danger?: boolean;
}
export interface PromptAnswer {
  text: string;
  choice: string | null;
}

type Pending =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (ok: boolean) => void }
  | { kind: "choice"; opts: ChoiceOpts; resolve: (value: string | null) => void };

const Ctx = createContext<{
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  choose: (opts: ChoiceOpts) => Promise<string | null>;
  prompt: (opts: PromptOpts) => Promise<PromptAnswer | null>;
}>({
  confirm: () => Promise.resolve(false),
  choose: () => Promise.resolve(null),
  prompt: () => Promise.resolve(null),
});

export function ConfirmProvider(props: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [prompting, setPrompting] = useState<{
    opts: PromptOpts;
    resolve: (a: PromptAnswer | null) => void;
  } | null>(null);
  const api = useRef({
    confirm: (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ kind: "confirm", opts, resolve })),
    choose: (opts: ChoiceOpts) =>
      new Promise<string | null>((resolve) => setPending({ kind: "choice", opts, resolve })),
    prompt: (opts: PromptOpts) => new Promise<PromptAnswer | null>((resolve) => setPrompting({ opts, resolve })),
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
      {prompting && (
        <PromptDialog
          opts={prompting.opts}
          onSettle={(a) => {
            prompting.resolve(a);
            setPrompting(null);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

/** Why a prompt's answer cannot be sent yet, or null when it can. Exported for its tests. */
export function promptProblem(opts: PromptOpts, text: string, choice: string | null): string | null {
  const t = text.trim();
  const needed =
    opts.select && opts.textRequiredFor ? opts.textRequiredFor.includes(choice ?? "") : (opts.minLength ?? 0) > 0;
  const min = Math.max(opts.minLength ?? 0, needed ? 1 : 0);
  if (needed && t.length < min) return min > 1 ? `Write at least ${min} characters.` : "Write a few words.";
  if (opts.maxLength && t.length > opts.maxLength) return `Keep it to ${opts.maxLength} characters.`;
  return null;
}

function PromptDialog(props: { opts: PromptOpts; onSettle: (a: PromptAnswer | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalDialog(ref, () => props.onSettle(null));
  const { opts } = props;
  const [choice, setChoice] = useState<string | null>(opts.select?.options[0]?.value ?? null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    const p = promptProblem(opts, text, choice);
    if (p) return setProblem(p);
    props.onSettle({ text: text.trim(), choice });
  };
  const errId = "prompt-err";
  return (
    <div className="confirm-backdrop" onClick={() => props.onSettle(null)}>
      <div
        ref={ref}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={opts.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{opts.title}</h3>
        {opts.message && <div className="confirm-body">{opts.message}</div>}
        <form
          className="prompt-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {opts.select && (
            <label className="prompt-field">
              {opts.select.label}
              <select data-autofocus value={choice ?? ""} onChange={(e) => setChoice(e.target.value)}>
                {opts.select.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="prompt-field">
            {opts.label}
            <textarea
              {...(opts.select ? {} : { "data-autofocus": true })}
              rows={3}
              value={text}
              placeholder={opts.placeholder}
              maxLength={opts.maxLength}
              aria-invalid={!!problem}
              aria-describedby={problem ? errId : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setProblem(null);
              }}
            />
          </label>
          {problem && (
            <p id={errId} className="error fine" role="alert">
              {problem}
            </p>
          )}
          <div className="row confirm-actions">
            <button type="submit" className={opts.danger ? "primary danger" : "primary"}>
              {opts.confirmLabel ?? "Send"}
            </button>
            <button type="button" onClick={() => props.onSettle(null)}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
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
/** Themed dialog that asks for words (and optionally one pick). Resolves the answer, or null on cancel. */
export function usePrompt() {
  return useContext(Ctx).prompt;
}
