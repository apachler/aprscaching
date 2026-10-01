// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Button — a real <button> with a token-styled variant (ui-ux.md §3). Every button in the app is this
 * component; a raw <button> appears only inside a primitive that owns its own markup (Segmented, Tabs, a
 * list row, the switch). Variants map to the CSS in styles/components/button.css:
 *
 *   primary        the one main action of a screen (Log a find)
 *   secondary      the default: any other action
 *   danger         a destructive action, confirmed before it runs
 *   quiet          a text-styled action in the heading colour ("Show the logbook", "Back")
 *   inline         a small underlined action beside a list row ("remove")
 *   inline-danger  the same, destructive
 *   icon           an icon alone; it needs an accessible name (aria-label or title)
 *   icon-subtle    a small muted icon alone, in a row's corner; it needs a name too
 */
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant =
  "primary" | "secondary" | "danger" | "quiet" | "inline" | "inline-danger" | "icon" | "icon-subtle";

const CLASS: Record<ButtonVariant, string> = {
  primary: "primary",
  secondary: "",
  danger: "danger",
  quiet: "link",
  inline: "link-btn",
  "inline-danger": "link-btn danger",
  icon: "icon",
  "icon-subtle": "iconbtn",
};

export function Button({
  variant = "secondary",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  if (import.meta.env?.DEV && (variant === "icon" || variant === "icon-subtle") && !rest["aria-label"] && !rest.title) {
    console.warn("Button: an icon-only button needs aria-label or title");
  }
  const cls = [CLASS[variant], className].filter(Boolean).join(" ");
  return <button className={cls || undefined} {...rest} />;
}
