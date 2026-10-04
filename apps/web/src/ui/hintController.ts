// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * When a hint shows and hides, apart from the DOM (Hint.tsx draws it). A mouse or pen resting on the control
 * opens it after a short delay, keyboard focus opens it at once, and a tap opens it only on a control made for
 * that (an InfoTip), since a tap on any other control is that control's action. It stays open while the pointer
 * moves onto the hint itself, so the text can be read and selected (WCAG 1.4.13), and Escape closes it.
 */

export interface HintTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface HintController {
  /** The pointer entered the control or the hint. Touch is ignored: a tap is the control's own action. */
  pointerEnter(pointerType: string): void;
  /** The pointer left the control or the hint. */
  pointerLeave(): void;
  /** The control took focus; `visible` when it came from the keyboard (`:focus-visible`). */
  focus(visible: boolean): void;
  blur(): void;
  /** A click on a control made for the hint: opens it and keeps it open until the next click, Escape or blur. */
  toggle(): void;
  /** Close an open hint; true when there was one to close. */
  escape(): boolean;
  isOpen(): boolean;
  dispose(): void;
}

/** How long the pointer rests before a hint opens, and how long it may cross the gap to the hint. */
export const SHOW_DELAY_MS = 350;
export const HIDE_DELAY_MS = 120;

const browserTimers: HintTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createHintController(o: {
  onOpen: () => void;
  onClose: () => void;
  timers?: HintTimers;
}): HintController {
  const timers = o.timers ?? browserTimers;
  let open = false;
  let pinned = false;
  let pending: unknown = null;

  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  const show = () => {
    cancel();
    if (!open) {
      open = true;
      o.onOpen();
    }
  };
  const hide = () => {
    cancel();
    pinned = false;
    if (open) {
      open = false;
      o.onClose();
    }
  };

  return {
    pointerEnter(pointerType) {
      if (pointerType === "touch") return;
      cancel();
      if (!open) pending = timers.set(show, SHOW_DELAY_MS);
    },
    pointerLeave() {
      if (pinned) return;
      cancel();
      if (open) pending = timers.set(hide, HIDE_DELAY_MS);
    },
    focus(visible) {
      if (visible) show();
    },
    blur: hide,
    toggle() {
      if (open && pinned) return hide();
      show();
      pinned = true;
    },
    escape() {
      const was = open;
      hide();
      return was;
    },
    isOpen: () => open,
    dispose: cancel,
  };
}

/**
 * Whether a control's content holds any words (a string or number anywhere in it), so a hint knows if it is the
 * control's name (an icon alone) or its description. `childrenOf` reads an element's children.
 */
export function hasWords(node: unknown, childrenOf: (n: never) => unknown): boolean {
  if (typeof node === "string") return node.trim() !== "";
  if (typeof node === "number") return true;
  if (Array.isArray(node)) return node.some((n) => hasWords(n, childrenOf));
  if (node && typeof node === "object") return hasWords(childrenOf(node as never), childrenOf);
  return false;
}

/** A CSS anchor name for a React id (`:r1:` is not a valid dashed ident). */
export const hintAnchor = (id: string): string => `--hint-${id.replace(/[^\w-]/g, "")}`;
