// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, type ReactNode } from "react";
import { useModalDialog } from "./useModalDialog.js";
import { Button } from "./Button.js";
import { Icon } from "./Icon.js";

/**
 * A modal sheet on a phone: from the bottom (a menu such as More) or the top (search). A real dialog (ui-ux.md §3,
 * §7): focus moves into it, Tab stays inside, Escape, the close button or a tap outside closes it, and focus returns
 * to the control that opened it.
 */
export function Sheet(props: {
  title: string;
  edge: "top" | "bottom";
  onClose: () => void;
  children: ReactNode;
  /** Show the title as a heading; a search sheet labels itself through its field instead. */
  showTitle?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalDialog(ref, props.onClose);
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div
        ref={ref}
        className={`sheet sheet-${props.edge}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          {props.showTitle !== false && <h2 className="sheet-title">{props.title}</h2>}
          <Button variant="icon" className="sheet-close" onClick={props.onClose} aria-label="Close" title="Close">
            <Icon name="close" size={18} />
          </Button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
