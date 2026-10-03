// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Badge / TierBadge — the one compact status chip (ui-ux.md §3). Colours derive from tokens in
 * styles/components/data.css (color-mix over the tier/status bases); pass the class suffix as `kind`
 * ("tierA" | "tierB" | "tierC" | "found" | "dnf" | …) or omit it for the neutral chip.
 */
import type { ReactNode } from "react";
import { Icon } from "./Icon.js";

export function Badge(props: { kind?: string; title?: string; className?: string; children: ReactNode }) {
  const cls = ["badge", props.kind, props.className].filter(Boolean).join(" ");
  return (
    <span className={cls} title={props.title}>
      {props.children}
    </span>
  );
}

/**
 * The one vocabulary for a find's trust tier, used on every surface. Tier A is a transmission heard on
 * the air by a receiving station this instance attests, through that station's own ingest — never a copy
 * relayed over APRS-IS. Tier B is the finder's own device location at the cache. Tier C is a find on
 * record that nothing corroborated.
 */
export const TIER_NAME: Record<"A" | "B" | "C", string> = {
  A: "Radio-verified",
  B: "Location-verified",
  C: "Logged",
};

/** One line on what each tier means, for help text and titles. */
export const TIER_DESC: Record<"A" | "B" | "C", string> = {
  A: "Heard on the air at the cache by this instance's own receiving station, with a plausible track.",
  B: "The finder's device location matched the cache when the find was logged.",
  C: "On record, but neither a receiving station nor the finder's device placed them at the cache.",
};

/**
 * Trust-tier chip: the tier's name, with the tier letter as a small secondary label when `letter` is set.
 * A find that did not meet its cache's minimum reads as Logged, whatever evidence it had.
 */
export function TierBadge(props: {
  tier?: "A" | "B" | "C" | null;
  verified?: boolean;
  letter?: boolean;
  title?: string;
}) {
  const t = props.verified === false ? "C" : (props.tier ?? "C");
  return (
    <Badge kind={`tier${t}`} title={props.title ?? TIER_DESC[t]}>
      {TIER_NAME[t]}
      {props.letter && <span className="badge-sub"> · Tier {t}</span>}
    </Badge>
  );
}

/**
 * Callsign control-verified chip: the account proved it controls the licence. It is about the account,
 * not about any find, so it wears the neutral chip with a tick — never a trust-tier colour.
 */
export function CallVerifiedBadge(props: { label?: string; title?: string }) {
  return (
    <Badge
      kind="callok"
      title={props.title ?? "You proved you hold this callsign: on the air, through ampr.org, LoTW or the sysop"}
    >
      <Icon name="check" size={12} /> {props.label ?? "you control this call"}
    </Badge>
  );
}

/** The short wording of a licence-register result, for badges and inline confirmations. */
export function licenceLabel(l: { status: string; sourceName?: string }): string {
  if (l.status === "licensed") return `listed in ${l.sourceName ?? "a public"} register`;
  if (l.status === "expired") return `listed as expired${l.sourceName ? ` (${l.sourceName})` : ""}`;
  return "not in a public register";
}

/**
 * Licence-register validity chip: is the call listed as licensed in a public register this instance
 * imports? Validity only — never "you control this call", and "not in a public register" is neutral, not an
 * error (many countries publish no register).
 */
export function LicenceBadge(props: { licence?: { status: string; sourceName?: string; expiresAt?: number } | null }) {
  const l = props.licence;
  if (!l) return null;
  const title =
    l.status === "licensed"
      ? `The ${l.sourceName ?? "public"} register lists this call as licensed. It shows the licence exists, not who uses it.`
      : l.status === "expired"
        ? `The ${l.sourceName ?? "public"} register lists this call, but not as currently licensed.`
        : "No public register this instance imports lists this call. Many countries publish none — this is not an error.";
  return (
    <Badge kind={l.status === "expired" ? "warn" : undefined} title={title}>
      {licenceLabel(l)}
    </Badge>
  );
}
