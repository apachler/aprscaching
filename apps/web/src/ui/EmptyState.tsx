// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * EmptyState — every list/collection defines one with a helpful next action (ui-ux.md §3, §9).
 * Renders as muted body text with an optional action below.
 */
import type { ReactNode } from "react";

export function EmptyState(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="muted">{props.children}</p>
      {props.action && <div className="empty-action">{props.action}</div>}
    </div>
  );
}
