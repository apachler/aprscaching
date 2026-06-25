/**
 * Operator data primitives (M8) — the trust-model made glanceable, in OUR palette (A=green /
 * B=blue / C=neutral; C is unverified, not an error). Token-driven, real semantics.
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export type Tier = "A" | "B" | "C";

/** Square letter chip (A/B/C) — solid tier colour, near-black letter. `lg` for headers. */
export function TierChip(props: { tier: Tier; lg?: boolean; title?: string }) {
  return <span className={`tierchip ${props.tier}${props.lg ? " lg" : ""}`} title={props.title}>{props.tier}</span>;
}

/** Minimum-verification-tier card: the chip + a one-line reason. */
export function MinTier(props: { tier: Tier; desc: string }) {
  return (
    <div className={`mintier ${props.tier}`}>
      <TierChip tier={props.tier} lg />
      <div className="mintier-t"><b>Min. verification · Tier {props.tier}</b><p>{props.desc}</p></div>
      <Icon name="shield-check" size={20} className={`tcol ${props.tier}`} />
    </div>
  );
}

/** Difficulty / terrain segmented bars (filled value of max). */
export function DtBars(props: { value: number; max?: number }) {
  const max = props.max ?? 5;
  return (
    <div className="dtbars" aria-hidden="true">
      {Array.from({ length: max }, (_, i) => <span key={i} className={i < Math.round(props.value) ? "on" : ""} />)}
    </div>
  );
}

/** A labelled stat (uppercase micro-label + mono value). */
export function Stat(props: { label: string; children: ReactNode }) {
  return <div><div className="stat-l">{props.label}</div><div className="stat-v">{props.children}</div></div>;
}

/** Verification-status panel: a stack of signal→state rows. */
export function VerifyPanel(props: { children: ReactNode }) {
  return <div className="verify">{props.children}</div>;
}

/** One verification row: an icon (state-coloured), a title + detail, and an optional trailing mark. */
export function VerifyRow(props: {
  icon: IconName; state?: "ok" | "warn" | "muted"; title: ReactNode; desc?: ReactNode; trailing?: ReactNode;
}) {
  return (
    <div className="verify-row">
      <Icon name={props.icon} size={20} className={`vr-ic ${props.state ?? "muted"}`} />
      <div className="vr-t"><b>{props.title}</b>{props.desc && <p>{props.desc}</p>}</div>
      {props.trailing}
    </div>
  );
}
