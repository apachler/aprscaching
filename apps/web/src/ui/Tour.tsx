// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";

export type TourStep = { title: string; body: string; when?: "signed-out" | "signed-in" };

const SEEN_KEY = "acs.tour.seen";
export const tourSeen = (): boolean => { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ } };

/**
 * Quick-tour framework — MECHANICS ONLY. Step content/targets are config-driven and deferred
 * (docs/18). An accessible (focus-trapped, keyboard-operable, reduced-motion) bottom-anchored
 * dialog; element-anchored coach-marks land with the real steps. Renders nothing for empty steps.
 */
export function Tour(props: { steps: TourStep[]; onDone: () => void }) {
  const { steps } = props;
  const [i, setI] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const finish = useCallback(() => { markSeen(); props.onDone(); }, [props]);

  // restore focus to whatever opened the tour when it closes (ui-ux.md §7)
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; return () => prev?.focus?.(); }, []);
  useEffect(() => { cardRef.current?.querySelector<HTMLElement>("button.primary")?.focus(); }, [i]);
  useEffect(() => {
    const card = cardRef.current; if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(); return; }
      if (e.key !== "Tab") return;
      const f = Array.from(card.querySelectorAll<HTMLElement>("button"));
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    card.addEventListener("keydown", onKey);
    return () => card.removeEventListener("keydown", onKey);
  }, [finish]);

  if (!steps.length) return null;
  const idx = Math.min(i, steps.length - 1);
  const step = steps[idx]!;
  const last = idx >= steps.length - 1;
  return (
    <div className="tour-scrim" onClick={finish}>
      <div className="tour-card" role="dialog" aria-modal="true" aria-label="Quick tour"
           ref={cardRef} onClick={(e) => e.stopPropagation()}>
        <div className="tour-stepn">Step {idx + 1} of {steps.length}</div>
        <h3>{step.title}</h3>
        <p className="muted">{step.body}</p>
        <div className="row end tour-actions">
          <button className="link" onClick={finish}>Skip</button>
          {idx > 0 && <button onClick={() => setI(idx - 1)}>Back</button>}
          <button className="primary" onClick={() => (last ? finish() : setI(idx + 1))}>{last ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}
