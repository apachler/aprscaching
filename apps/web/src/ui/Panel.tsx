/**
 * Panel — the shared docked-drawer / bottom-sheet surface every overlay uses (ui-ux.md §3
 * "Drawer / side panel" + "Bottom sheet"). One header anatomy: title left, optional actions and a
 * close button right. Responsive docked↔sheet behaviour lives in styles.css (.panel is a query
 * container; the panel↔sheet swap is a viewport media query).
 */
import type { ReactNode } from "react";

export function Panel(props: {
  title: ReactNode; onClose?: () => void; side?: "left" | "right"; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <aside className={`panel ${props.side ?? "right"}`}>
      <div className="row between">
        <h2>{props.title}</h2>
        <span className="spacer" />
        {props.actions}
        {props.onClose && <button className="icon" aria-label="Close" onClick={props.onClose}>✕</button>}
      </div>
      {props.children}
    </aside>
  );
}
