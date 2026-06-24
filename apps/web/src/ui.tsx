/**
 * ui.tsx — shared primitives governed by .claude/rules/ui-ux.md + css.md.
 * The settings/dense-config architecture (§2): grouped cards with a master switch, collapse,
 * status at the header, and a one-line reason when a group is unavailable. All controls are real
 * semantic elements (role=switch button, <button> disclosures) — no CSS-only widget hacks — and
 * appearance is token-driven (no inline color/spacing). Transitions animate transform/opacity only
 * and honour prefers-reduced-motion (see styles.css).
 */
import { useState, type ReactNode } from "react";

/** An accessible on/off switch (use this, not a checkbox, to enable a feature or group). */
export function Switch(props: { checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={props.checked} aria-label={props.label}
      className={`sw${props.checked ? " on" : ""}`} disabled={props.disabled}
      onClick={() => !props.disabled && props.onChange?.(!props.checked)}
    >
      <span className="knob" aria-hidden="true" />
    </button>
  );
}

/**
 * A labelled, collapsible settings group. With `master`, it's a toggle-gated subsystem: when the
 * master switch is off, the body collapses to the `reason` (or nothing) instead of dead controls.
 */
export function Group(props: {
  title: string; status?: string; defaultOpen?: boolean; reason?: ReactNode; children?: ReactNode;
  master?: { on: boolean; set: (v: boolean) => void; disabled?: boolean };
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const masterOff = props.master ? !props.master.on : false;
  const bodyId = `grp-${props.title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className="group">
      <header className="group-h">
        <button className="group-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          <span className={`chev${open ? " open" : ""}`} aria-hidden="true">▸</span> {props.title}
        </button>
        {props.status && <span className="group-status">{props.status}</span>}
        {props.master && <Switch label={props.title} checked={props.master.on} disabled={props.master.disabled} onChange={props.master.set} />}
      </header>
      {open && (masterOff
        ? (props.reason && <p id={bodyId} className="group-reason">{props.reason}</p>)
        : <div id={bodyId} className="group-body">{props.children}</div>)}
    </section>
  );
}

/** A single setting row: label (+ optional help) on the left, control on the right. */
export function Row(props: { label: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="setrow">
      <div className="setrow-l"><div>{props.label}</div>{props.help && <div className="muted setrow-help">{props.help}</div>}</div>
      <div className="setrow-c">{props.children}</div>
    </div>
  );
}

/** Expert options, collapsed by default (real disclosure, not a CSS hack). */
export function Advanced(props: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="adv">
      <button className="adv-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`chev${open ? " open" : ""}`} aria-hidden="true">▸</span> {props.label ?? "Advanced"}
      </button>
      {open && <div className="adv-body">{props.children}</div>}
    </div>
  );
}
