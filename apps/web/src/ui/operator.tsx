// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operator data primitives — the trust-model made glanceable, in OUR palette (A=green /
 * B=blue / C=neutral; C is unverified, not an error). Token-driven, real semantics.
 */
import type { ReactNode } from "react";
import { Icon } from "./Icon.js";
import { TIER_NAME, TIER_DESC } from "./Badge.js";
import { Hint } from "./Hint.js";

export type Tier = "A" | "B" | "C";

/** Square letter chip (A/B/C) — solid tier colour, near-black letter. `lg` for headers. */
export function TierChip(props: { tier: Tier; lg?: boolean; title?: string }) {
  const chip = <span className={`tierchip ${props.tier}${props.lg ? " lg" : ""}`}>{props.tier}</span>;
  return props.title ? <Hint text={props.title}>{chip}</Hint> : chip;
}

/** A cache's minimum verification: the tier a find there must reach to count, by name, with its meaning. */
export function MinTier(props: { tier: Tier }) {
  return (
    <div className={`mintier ${props.tier}`}>
      <TierChip tier={props.tier} lg />
      <div className="mintier-t">
        <b>
          {props.tier === "C"
            ? "Every logged find counts"
            : `Needs a ${TIER_NAME[props.tier]} find${props.tier === "B" ? " or better" : ""}`}
        </b>
        <p>{TIER_DESC[props.tier]}</p>
      </div>
      <Icon name="shield-check" size={20} className={`tcol ${props.tier}`} />
    </div>
  );
}

/** Difficulty / terrain segmented bars (filled value of max). */
export function DtBars(props: { value: number; max?: number }) {
  const max = props.max ?? 5;
  return (
    <div className="dtbars" aria-hidden="true">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < Math.round(props.value) ? "on" : ""} />
      ))}
    </div>
  );
}

/** A labelled stat (uppercase micro-label + mono value). */
export function Stat(props: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="stat-l">{props.label}</div>
      <div className="stat-v">{props.children}</div>
    </div>
  );
}
