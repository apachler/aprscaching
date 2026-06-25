/**
 * Button — a real <button> with a token-styled variant (ui-ux.md §3). Variants map to the CSS in
 * styles.css; "secondary" is the unstyled default. Use this so every button shares one component.
 */
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "link" | "icon";

export function Button({ variant = "secondary", className, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const v = variant === "secondary" ? "" : variant;
  const cls = [v, className].filter(Boolean).join(" ");
  return <button className={cls || undefined} {...rest} />;
}
