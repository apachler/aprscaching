// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";

/** The part of `document` a poller needs: whether the page is hidden, and when that changes. */
type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/**
 * Run `fn` every `ms` while the page is visible. A hidden tab stops polling (no requests, no battery);
 * when it becomes visible again `fn` runs at once and the interval resumes. `immediate: false` waits
 * one interval before the first run. Every run receives a signal that aborts once polling stops, so a
 * response arriving after that can be dropped. Returns the stop function.
 */
export function startPoll(
  fn: (signal: AbortSignal) => void,
  ms: number,
  doc: Visibility | undefined,
  opts: { immediate?: boolean } = {},
): () => void {
  const ctl = new AbortController();
  const tick = () => fn(ctl.signal);
  let timer: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    if (timer === undefined) timer = setInterval(tick, ms);
  };
  const pause = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const onVisibility = () => {
    if (doc?.hidden) pause();
    else if (timer === undefined) {
      tick();
      run();
    }
  };
  if (!doc?.hidden) {
    if (opts.immediate ?? true) tick();
    run();
  }
  doc?.addEventListener("visibilitychange", onVisibility);
  return () => {
    ctl.abort();
    pause();
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Poll `fn` every `ms` while the page is visible (see startPoll) and `enabled` holds. The latest `fn`
 * is always the one called, so it may close over fresh state without restarting the interval.
 */
export function usePoll(
  fn: (signal: AbortSignal) => void,
  ms: number,
  opts: { enabled?: boolean; immediate?: boolean } = {},
): void {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const enabled = opts.enabled ?? true;
  const immediate = opts.immediate ?? true;
  useEffect(() => {
    if (!enabled) return;
    return startPoll((signal) => fnRef.current(signal), ms, typeof document === "undefined" ? undefined : document, {
      immediate,
    });
  }, [ms, enabled, immediate]);
}
