// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Disclosure — the one collapse/expand affordance for secondary content (ui-ux.md §3): a real
 * button with aria-expanded, glyph + label, body rendered only while open.
 */
import { useState, type ReactNode } from "react";

export function Disclosure(props: {
  label: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className={["disclosure", props.className].filter(Boolean).join(" ")}>
      <button className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {props.label}
      </button>
      {open && <div className="disclosure-body">{props.children}</div>}
    </div>
  );
}
