/**
 * Badge / TierBadge — the one compact status chip (ui-ux.md §3). Colours derive from tokens in
 * styles.css (color-mix over the tier/status bases); pass the class suffix as `kind`
 * ("tierA" | "tierB" | "tierC" | "found" | "dnf" | …) or omit it for the neutral chip.
 */
import type { ReactNode } from "react";

export function Badge(props: { kind?: string; title?: string; className?: string; children: ReactNode }) {
  const cls = ["badge", props.kind, props.className].filter(Boolean).join(" ");
  return <span className={cls} title={props.title}>{props.children}</span>;
}

/** Trust-tier chip with the standard short label (RF / App / tier letter). */
export function TierBadge(props: { tier?: "A" | "B" | "C" | null; verified?: boolean; prefix?: string; title?: string }) {
  if (props.verified === false) {
    return <Badge kind="tierC" title={props.title}>{props.prefix ? `${props.prefix} · ` : ""}unverified</Badge>;
  }
  const t = props.tier ?? "C";
  const label = t === "A" ? "RF" : t === "B" ? "App" : String(t);
  return <Badge kind={`tier${t}`} title={props.title}>{props.prefix ? `${props.prefix} · ` : ""}{label}</Badge>;
}
