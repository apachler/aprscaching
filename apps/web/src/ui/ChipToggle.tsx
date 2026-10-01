// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ChipToggle — one chip of a multi-select filter (cache types, bands, modes): a Button that is pressed or
 * not, with aria-pressed, filled when on. A row of them sits in `.chip-row`. For one choice among a few, use
 * Segmented.
 */
import type { ReactNode } from "react";
import { Button } from "./Button.js";

export function ChipToggle(props: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant={props.pressed ? "primary" : "secondary"}
      className="chip-btn"
      aria-pressed={props.pressed}
      title={props.title}
      onClick={() => props.onChange(!props.pressed)}
    >
      {props.children}
    </Button>
  );
}
