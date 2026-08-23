// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type TourStep = {
  title: string;
  body: string;
  when?: "signed-out" | "signed-in";
  /** Selector for the element this step points at — a `[data-tour="…"]` hook, never a style class. */
  anchor?: string;
};

const SEEN_KEY = "acs.tour.seen";
export const tourSeen = (): boolean => {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
};
const markSeen = () => {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
};

/**
 * The element a step points at: the first match that is actually rendered. A hook appears more than
 * once by design — Nearby is a rail item on desktop and a tab on mobile — and the breakpoint decides
 * which one exists, so the first laid-out match is the one on screen. `getClientRects()` is empty for
 * anything a `display: none` ancestor hides, which is exactly how the responsive chrome hides.
 */
function visibleTarget(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) if (el.getClientRects().length) return el;
  return null;
}

/**
 * Quick-tour coach marks. Steps are config-driven (`tourSteps.ts`) and filtered by session, so the
 * closing step differs for a visitor and a signed-in cacher. A step naming an on-screen element gets
 * a ring and an anchored card; one whose element is absent falls back to the centred dialog rather
 * than pointing at nothing. Either way the dialog is focus-trapped, keyboard-operable and
 * reduced-motion aware. Renders nothing when no step applies.
 */
export function Tour(props: { steps: TourStep[]; signedIn: boolean; onDone: () => void }) {
  const { steps, signedIn, onDone } = props;
  const shown = useMemo(
    () => steps.filter((s) => !s.when || s.when === (signedIn ? "signed-in" : "signed-out")),
    [steps, signedIn],
  );
  const [i, setI] = useState(0);
  const [anchored, setAnchored] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const finish = useCallback(() => {
    markSeen();
    onDone();
  }, [onDone]);

  const idx = Math.min(i, Math.max(shown.length - 1, 0));
  const step = shown[idx];
  const anchor = step?.anchor;

  // restore focus to whatever opened the tour when it closes (ui-ux.md §7)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  // Ring the step's element and let CSS anchor the card to it. The class is the only thing set from
  // JS — `anchor-name`, the ring and the placement all live in the stylesheet (css.md).
  useEffect(() => {
    const target = anchor ? visibleTarget(anchor) : null;
    setAnchored(!!target);
    if (!target) return;
    target.classList.add("tour-target");
    target.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    return () => target.classList.remove("tour-target");
  }, [anchor]);

  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>("button.primary")?.focus();
  }, [idx]);
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
        return;
      }
      if (e.key !== "Tab") return;
      const f = Array.from(card.querySelectorAll<HTMLElement>("button"));
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
    card.addEventListener("keydown", onKey);
    return () => card.removeEventListener("keydown", onKey);
  }, [finish]);

  if (!step) return null;
  const last = idx >= shown.length - 1;
  const titleId = "tour-step-title";
  return (
    <div className="tour-scrim" data-anchored={anchored ? "true" : undefined} onClick={finish}>
      <div
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tour-stepn">
          Step {idx + 1} of {shown.length}
        </div>
        <h3 id={titleId}>{step.title}</h3>
        <p className="muted">{step.body}</p>
        <div className="row end tour-actions">
          <button className="link" onClick={finish}>
            Skip
          </button>
          {idx > 0 && <button onClick={() => setI(idx - 1)}>Back</button>}
          <button className="primary" onClick={() => (last ? finish() : setI(idx + 1))}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
