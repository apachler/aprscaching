// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/index.js";
import {
  LocationError,
  PROBLEM_TEXT,
  requestFix,
  waitingText,
  type DeviceFix,
  type LocationProblem,
} from "./location.js";

/** How a request ended: a reading, a problem to show, or the user's own choice to stop or skip. */
export type LocateOutcome = { fix: DeviceFix } | { problem: LocationProblem } | { cancelled: true } | { skipped: true };

interface Waiting {
  elapsedMs: number;
  hint: LocationProblem | null;
}

/**
 * The React side of `requestFix`: the waiting progress, the last problem, and cancel / skip. A
 * request still running when the component unmounts is cancelled.
 */
export function useLocate() {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [problem, setProblem] = useState<LocationProblem | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const skip = useRef(false);
  useEffect(() => () => ctl.current?.abort(), []);

  const locate = useCallback(async (maxAgeMs: number): Promise<LocateOutcome> => {
    ctl.current?.abort();
    const ac = new AbortController();
    ctl.current = ac;
    skip.current = false;
    setProblem(null);
    setWaiting({ elapsedMs: 0, hint: null });
    try {
      const fix = await requestFix({
        maxAgeMs,
        signal: ac.signal,
        onWaiting: (elapsedMs, hint) => setWaiting({ elapsedMs, hint }),
      });
      return { fix };
    } catch (e) {
      const kind = e instanceof LocationError ? e.kind : "unavailable";
      if (kind === "cancelled") return skip.current ? { skipped: true } : { cancelled: true };
      setProblem(kind);
      return { problem: kind };
    } finally {
      if (ctl.current === ac) {
        ctl.current = null;
        setWaiting(null);
      }
    }
  }, []);

  const cancel = useCallback(() => ctl.current?.abort(), []);
  /** Stop waiting and carry on without a reading. */
  const skipWait = useCallback(() => {
    skip.current = true;
    ctl.current?.abort();
  }, []);
  const clearProblem = useCallback(() => setProblem(null), []);
  return { locate, cancel, skipWait, waiting, problem, clearProblem };
}

/**
 * The waiting line ("Waiting for GPS… 23 s") with its cancel action, or the problem in one line.
 * `skipLabel` adds a second action that carries on without a reading.
 */
export function LocateStatus(props: {
  waiting: Waiting | null;
  problem: LocationProblem | null;
  onCancel: () => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  if (props.waiting)
    return (
      <div className="locate-status" role="status" aria-live="polite">
        <span className="locate-status-text">{waitingText(props.waiting.elapsedMs, props.waiting.hint)}</span>
        <span className="locate-status-actions">
          {props.onSkip && (
            <Button variant="quiet" onClick={props.onSkip}>
              {props.skipLabel ?? "Skip"}
            </Button>
          )}
          <Button variant="quiet" onClick={props.onCancel}>
            Cancel
          </Button>
        </span>
      </div>
    );
  if (props.problem)
    return (
      <p className="inline-note" role="alert">
        {PROBLEM_TEXT[props.problem]}
      </p>
    );
  return null;
}
