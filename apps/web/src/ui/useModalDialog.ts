// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, type RefObject } from "react";

/**
 * Modal-dialog behaviour for a container ref (ui-ux.md §7): focus the primary control on open, trap
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
      el.querySelector<HTMLElement>("button.primary") ??
      el.querySelector<HTMLElement>("button, input, select, textarea, a[href]")
    )?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
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
