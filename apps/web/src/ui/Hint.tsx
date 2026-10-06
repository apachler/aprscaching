// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hint — the one short "what does this do" text for a control or a term (ui-ux.md §3, Popover). It wraps a
 * single element and shows a one-line hint beside it on mouse hover and on keyboard focus; `aria-describedby`
 * gives screen readers the same words. The hint is a manual popover in the top layer, so no panel's overflow
 * clips it, placed by CSS anchor positioning where the browser has it and as a bar above the bottom edge where it
 * does not (styles/components/hint.css). Nothing is measured in JS.
 *
 * The hint is rendered inside the element it explains, so the element's layout and its siblings stay as they
 * were, and moving the pointer from the element onto the hint keeps it open. The child must be one element with
 * children of its own that passes `style`, `aria-describedby`, `data-hint` and the pointer, focus and key
 * handlers through to its DOM node: an HTML element, Button or Badge. A control with no visible words (an icon
 * button) takes the text as its accessible name instead, with `describe={false}`.
 *
 * InfoTip is the hint for a term or a group that has no control of its own: a small "i" button that opens the
 * hint on hover, focus and tap.
 */
import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Icon } from "./Icon.js";
import { createHintController, hintAnchor, type HintController } from "./hintController.js";

type Handler<E> = ((e: E) => void) | undefined;
interface HostProps {
  style?: CSSProperties;
  children?: ReactNode;
  "aria-describedby"?: string;
  onPointerEnter?: Handler<PointerEvent>;
  onPointerLeave?: Handler<PointerEvent>;
  onFocus?: Handler<FocusEvent>;
  onBlur?: Handler<FocusEvent>;
  onKeyDown?: Handler<KeyboardEvent>;
  onClick?: Handler<MouseEvent>;
}

const chain =
  <E,>(theirs: Handler<E>, ours: (e: E) => void) =>
  (e: E) => {
    theirs?.(e);
    ours(e);
  };

/** Whether focus came from the keyboard; a browser without :focus-visible counts every focus. */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function Hint(props: {
  /** One line, in the app's words: what the control does or what the term means. */
  text: string;
  children: ReactElement<HostProps>;
  /** False when the text is already the control's accessible name (an icon button's aria-label). */
  describe?: boolean;
  /** A click on the child opens and closes the hint (InfoTip); otherwise a click is the child's own action. */
  toggle?: boolean;
  /** Open below the element rather than above it, for a control whose field or text sits right above. */
  below?: boolean;
  /** The control's own name, shown at the head of the hint where the control hides its words (the compact rail);
   * hidden from assistive tech, which already reads it as the name. */
  title?: string;
}) {
  const id = useId();
  const anchor = hintAnchor(id);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const ctl = useRef<HintController | null>(null);
  ctl.current ??= createHintController({ onOpen: () => setOpen(true), onClose: () => setOpen(false) });
  const c = ctl.current;
  useEffect(() => () => c.dispose(), [c]);

  useEffect(() => {
    const tip = tipRef.current;
    if (!tip || typeof tip.showPopover !== "function") return; // the CSS fallback shows it from data-open
    try {
      if (open) tip.showPopover();
      else tip.hidePopover();
    } catch {
      // already in that state, or the hint has left the document
    }
  }, [open]);

  // While open: Escape anywhere closes it (a hover-opened hint has no focus to catch the key), and so does a tap
  // elsewhere (a button does not take focus on every platform, so blur alone would leave a tapped one open).
  useEffect(() => {
    if (!open) return;
    const host = tipRef.current?.parentElement;
    const away = (e: Event) => {
      if (!host?.contains(e.target as Node | null)) c.blur();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") c.escape();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open, c]);

  const own = props.children.props;
  const describedBy =
    props.describe === false ? own["aria-describedby"] : [own["aria-describedby"], id].filter(Boolean).join(" ");
  const extra: Partial<HostProps> & { "data-hint": string } = {
    style: { ...own.style, "--hint-anchor": anchor } as CSSProperties,
    "data-hint": "",
    "aria-describedby": describedBy || undefined,
    onPointerEnter: chain(own.onPointerEnter, (e: PointerEvent) => c.pointerEnter(e.pointerType)),
    onPointerLeave: chain(own.onPointerLeave, () => c.pointerLeave()),
    onFocus: chain(own.onFocus, (e: FocusEvent) => c.focus(focusVisible(e.currentTarget))),
    onBlur: chain(own.onBlur, () => c.blur()),
    onKeyDown: chain(own.onKeyDown, (e: KeyboardEvent) => {
      if (e.key === "Escape" && c.escape()) e.stopPropagation();
    }),
  };
  if (props.toggle) extra.onClick = chain(own.onClick, () => c.toggle());

  const tip = (
    <span
      ref={tipRef}
      id={id}
      role="tooltip"
      popover="manual"
      className="hint"
      data-open={open ? "" : undefined}
      data-below={props.below ? "" : undefined}
      style={{ "--hint-anchor": anchor } as CSSProperties}
      // the hint sits inside its control: a click on it is not the control's action
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      {props.title && (
        <span className="hint-title" aria-hidden="true">
          {props.title}
        </span>
      )}
      {props.text}
    </span>
  );
  const kids = own.children === undefined ? [] : Array.isArray(own.children) ? own.children : [own.children];
  return cloneElement(props.children, extra, ...(kids as ReactNode[]), tip);
}

/** A small "i" button that explains the term or group beside it; `label` names the button for screen readers. */
export function InfoTip(props: { text: string; label?: string; className?: string }) {
  return (
    <Hint text={props.text} toggle>
      <button
        type="button"
        className={["iconbtn", "infotip", props.className].filter(Boolean).join(" ")}
        aria-label={props.label ?? "What's this?"}
      >
        <Icon name="info" size={14} cp437="?" />
      </button>
    </Hint>
  );
}
