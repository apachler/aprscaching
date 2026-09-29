// SPDX-License-Identifier: AGPL-3.0-or-later
/** Card — a grouped block of related content/controls (ui-ux.md §3 "Card"). Token-styled. */
import type { HTMLAttributes } from "react";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={className ? `card ${className}` : "card"} {...rest} />;
}
