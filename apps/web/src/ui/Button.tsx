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
 *   icon           an icon alone; it needs an accessible name (aria-label, hint or title)
 *   icon-subtle    a small muted icon alone, in a row's corner; it needs a name too
 *
 * `hint` (or `title`, which means the same) is the one line that says what the button does, shown on hover and
 * keyboard focus by Hint, never as the browser's own title tooltip. A button with no words of its own (an icon)
 * and no aria-label takes it as its accessible name; any other button takes it as its description.
 */
import { isValidElement, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Hint } from "./Hint.js";
import { hasWords } from "./hintController.js";

type ButtonVariant = "primary" | "secondary" | "danger" | "quiet" | "inline" | "inline-danger" | "icon" | "icon-subtle";

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

const childrenOf = (n: ReactNode): ReactNode =>
  isValidElement<{ children?: ReactNode }>(n) ? n.props.children : undefined;

export function Button({
  variant = "secondary",
  className,
  hint,
  title,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; hint?: string }) {
  const text = hint ?? title;
  const iconOnly = variant === "icon" || variant === "icon-subtle";
  if (import.meta.env?.DEV && iconOnly && !rest["aria-label"] && !text) {
    console.warn("Button: an icon-only button needs aria-label or hint");
  }
  const cls = [CLASS[variant], className].filter(Boolean).join(" ");
  const label = rest["aria-label"] ?? (iconOnly || !hasWords(rest.children, childrenOf) ? text : undefined);
  const button = <button className={cls || undefined} {...rest} aria-label={label} />;
  if (!text) return button;
  return (
    <Hint text={text} describe={label !== text}>
      {button}
    </Hint>
  );
}
