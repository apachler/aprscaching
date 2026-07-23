// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Panel — the shared docked-drawer / bottom-sheet surface every overlay uses (ui-ux.md §3
 * "Drawer / side panel" + "Bottom sheet"). One header anatomy: title left, optional actions and a
 * close button right. Responsive docked↔sheet behaviour lives in styles.css (.panel is a query
 * container; the panel↔sheet swap is a viewport media query).
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export function Panel(props: {
  title: ReactNode;
  onClose?: () => void;
  side?: "left" | "right";
  actions?: ReactNode;
  children: ReactNode;
  /** Dense workspace surfaces (packet terminal, BBS) fill the content area at ≥1024px instead of
   *  docking as a slim ~348px drawer — the map hides while the surface is active (see css.md). */
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const { onClose } = props;
  // Move focus into the drawer on open so keyboard/AT users land inside it, and return focus to the
  // control that opened it on close (ui-ux.md §7). Not a modal focus-trap — the panel coexists with
  // the map — so Escape-to-close is scoped to the panel (bubbles from its children), not the document.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKeyDown = onClose
    ? (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }
    : undefined;
  return (
    // Wide surfaces are the shack apps (terminal, BBS, node, tools…). Mark them with the terminal
    // shell so the Phosphor theme can transform them into bordered CRT windows; the CSS
    // gates on [data-theme="phosphor"], so the attribute is inert in Modern.
    <aside
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-shell={props.wide ? "terminal" : undefined}
      data-density={props.wide ? "compact" : undefined}
      className={`panel ${props.side ?? "right"}${props.wide ? " panel-wide" : ""}`}
    >
      <div className="row between">
        <h2>{props.title}</h2>
        <span className="spacer" />
        {props.actions}
        {onClose && (
          <button className="icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        )}
      </div>
      {/* Shack apps are desktop-density; on a narrow viewport show a one-line hint (CSS-gated, so
          it's free on desktop). Not blocking — the app still works. */}
      {props.wide && (
        <p className="wide-hint" role="note">
          Best on a wider screen — this Shack app is built for desktop.
        </p>
      )}
      {props.children}
    </aside>
  );
}
