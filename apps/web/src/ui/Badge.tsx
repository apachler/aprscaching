// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Badge / TierBadge — the one compact status chip (ui-ux.md §3). Colours derive from tokens in
 * styles.css (color-mix over the tier/status bases); pass the class suffix as `kind`
 * ("tierA" | "tierB" | "tierC" | "found" | "dnf" | …) or omit it for the neutral chip.
 */
import type { ReactNode } from "react";

export function Badge(props: { kind?: string; title?: string; className?: string; children: ReactNode }) {
  const cls = ["badge", props.kind, props.className].filter(Boolean).join(" ");
  return (
    <span className={cls} title={props.title}>
      {props.children}
    </span>
  );
}

/** Trust-tier chip with the standard short label (RF / App / tier letter). */
export function TierBadge(props: {
  tier?: "A" | "B" | "C" | null;
  verified?: boolean;
  prefix?: string;
  title?: string;
}) {
  if (props.verified === false) {
    return (
      <Badge kind="tierC" title={props.title}>
        {props.prefix ? `${props.prefix} · ` : ""}unverified
      </Badge>
    );
  }
  const t = props.tier ?? "C";
  const label = t === "A" ? "RF" : t === "B" ? "App" : String(t);
  return (
    <Badge kind={`tier${t}`} title={props.title}>
      {props.prefix ? `${props.prefix} · ` : ""}
      {label}
    </Badge>
  );
}

/** The short wording of a licence-register result, for badges and inline confirmations. */
export function licenceLabel(l: { status: string; sourceName?: string }): string {
  if (l.status === "licensed") return `licence confirmed${l.sourceName ? ` (${l.sourceName})` : ""}`;
  if (l.status === "expired") return "licence expired";
  return "not found in public registers";
}

/**
 * Licence-register validity chip: is the call listed as licensed in a public register this instance
 * imports? Validity only — it is never the control-verified tick, and "not found" is neutral, not an
 * error (many countries publish no register).
 */
export function LicenceBadge(props: { licence?: { status: string; sourceName?: string; expiresAt?: number } | null }) {
  const l = props.licence;
  if (!l) return null;
  const title =
    l.status === "licensed"
      ? `Listed as licensed in the ${l.sourceName ?? "public"} register. This confirms the call exists, not who controls it.`
      : l.status === "expired"
        ? `The ${l.sourceName ?? "public"} register lists this call, but not as currently licensed.`
        : "No public register this instance imports lists this call. Many countries publish none — this is not an error.";
  return (
    <Badge kind={l.status === "expired" ? "warn" : undefined} title={title}>
      {licenceLabel(l)}
    </Badge>
  );
}
