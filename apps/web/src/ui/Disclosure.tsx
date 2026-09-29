// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Disclosure — the one collapse/expand affordance for secondary content (ui-ux.md §3): a real
 * button with aria-expanded, glyph + label, body rendered only while open. Two looks: "inline" (a
 * link-styled toggle inside content, e.g. a cache hint) and "section" (a heading-weight toggle for a
 * block of options, e.g. Advanced settings).
 */
import { useId, useState, type ReactNode } from "react";

export function Disclosure(props: {
  label: ReactNode;
  defaultOpen?: boolean;
  variant?: "inline" | "section";
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const bodyId = useId();
  const section = props.variant === "section";
  return (
    <div className={[section ? "adv" : "disclosure", props.className].filter(Boolean).join(" ")}>
      <button
        className={section ? "adv-toggle" : "link"}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        {section ? (
          <span className={`chev${open ? " open" : ""}`} aria-hidden="true">
            ▸
          </span>
        ) : (
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        )}{" "}
        {props.label}
      </button>
      {open && (
        <div id={bodyId} className={section ? "adv-body" : "disclosure-body"}>
          {props.children}
        </div>
      )}
    </div>
  );
}
