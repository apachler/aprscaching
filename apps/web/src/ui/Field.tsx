// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Field — a labelled form control whose label line also holds a button: an InfoTip beside the words, or a Copy
 * button beside the field (ui-ux.md §7, "Label every control"). The label names the control through `htmlFor`, and
 * the buttons sit outside it: a label labels its first labelable descendant, and a button is one, so a button
 * inside the label would take the field's name and turn a tap on the words into a tap on the button. It looks like
 * the bare `<label>` it stands in for (styles/base.css).
 */
import { useId, type ReactNode } from "react";

export function Field(props: {
  label: ReactNode;
  /** An InfoTip for the term the label names, shown right after the words. */
  info?: ReactNode;
  className?: string;
  /** The control, given the id the label points at. */
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={["field", props.className].filter(Boolean).join(" ")}>
      <label htmlFor={id}>{props.label}</label>
      {props.info && <> {props.info}</>}
      {props.children(id)}
    </div>
  );
}
