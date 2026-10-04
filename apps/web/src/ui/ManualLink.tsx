// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ManualLink — a link to a page of the published manual (brand.ts `manualUrl`). The manual is its own site, so the
 * link opens in a new tab, says so to a screen reader, and carries the external-link icon.
 */
import type { ReactNode } from "react";
import { manualUrl } from "../brand.js";
import { Icon } from "./Icon.js";

export function ManualLink(props: { page?: string; anchor?: string; className?: string; children?: ReactNode }) {
  return (
    <a
      className={["ext-link", props.className].filter(Boolean).join(" ")}
      href={manualUrl(props.page, props.anchor)}
      target="_blank"
      rel="noopener"
    >
      {props.children ?? "More in the manual"}
      <Icon name="external" size={12} cp437="" className="ext-ic" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
