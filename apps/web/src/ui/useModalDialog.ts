// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, type RefObject } from "react";

/**
 * Modal-dialog behaviour for a container ref (ui-ux.md §7): focus the control marked `data-autofocus`, else the
 * primary control, on open, trap
 * Tab within the dialog, close on Escape, and restore focus to the opener on close. Pair with
 * `role="dialog" aria-modal="true"` on the same element. `onClose` may be a fresh closure each render
 * (held in a ref) so the effect doesn't re-run — and re-steal focus — on every parent re-render.
 */
export function useModalDialog(ref: RefObject<HTMLElement | null>, onClose: () => void, open = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    (
      el.querySelector<HTMLElement>("[data-autofocus]") ??
      el.querySelector<HTMLElement>("button.primary") ??
      el.querySelector<HTMLElement>("button, input, select, textarea, a[href]")
    )?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An open popup inside the dialog takes the first Escape, so it closes alone: a combobox's list of options,
        // or the note it shows in their place (`data-popup-open`, since a combobox with no options is not expanded).
        const t = e.target as Element | null;
        if (
          t?.getAttribute?.("role") === "combobox" &&
          (t.getAttribute("aria-expanded") === "true" || t.hasAttribute("data-popup-open"))
        )
          return;
        // Stopping here keeps the key from the surfaces around this one: a native listener of an outer dialog
        // and React's root and portal listeners, through which a panel's onKeyDown would close it too.
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = Array.from(
        el.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select, textarea"),
      );
      if (!f.length) return;
      const first = f[0]!,
        last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [ref, open]);
}
