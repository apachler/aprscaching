// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Segmented — pick one of 2–4 modes (ui-ux.md §3): Appearance, units, a time window, a basemap. A group of
 * real buttons with aria-pressed; the selected one carries the accent fill. `look="chips"` lays the segments
 * out full width as boxed chips (the Nearby filter); `look="overlay"` is the compact bar that floats over the
 * map (the basemap switch). For on/off of a single feature use Switch; for views of one surface use Tabs.
 */
import type { ReactNode } from "react";
import { Hint } from "./Hint.js";

const LOOK = { bar: "seg", chips: "seg-chips", overlay: "basemap-switch" } as const;

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>(props: {
  /** what is being picked, for assistive technology */
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  look?: "bar" | "chips" | "overlay";
  className?: string;
}) {
  return (
    <div
      className={[LOOK[props.look ?? "bar"], props.className].filter(Boolean).join(" ")}
      role="group"
      aria-label={props.label}
    >
      {props.options.map((o) => {
        const seg = (
          <button
            key={o.value}
            type="button"
            className={o.value === props.value ? "on" : undefined}
            aria-pressed={o.value === props.value}
            disabled={o.disabled}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        );
        return o.title ? (
          <Hint key={o.value} text={o.title}>
            {seg}
          </Hint>
        ) : (
          seg
        );
      })}
    </div>
  );
}
