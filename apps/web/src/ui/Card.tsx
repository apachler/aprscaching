// SPDX-License-Identifier: AGPL-3.0-or-later
/** Card — a grouped block of related content/controls (ui-ux.md §3 "Card"). Token-styled. */
import type { ReactNode } from "react";

export function Card(props: { className?: string; children: ReactNode }) {
  return <div className={`card${props.className ? " " + props.className : ""}`}>{props.children}</div>;
}
