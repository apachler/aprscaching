// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export interface LoadState<T> {
  /** The last successful result; kept while a reload is in flight or after it fails. */
  data: T | undefined;
  /** The last failure's message, cleared when a load starts. */
  error: string | null;
  loading: boolean;
}

/**
 * Start one load: mark it loading, run the fetcher, and store its result or its error. Returns the
 * cancel function, which aborts the request's signal and drops whatever it settles with later — so a
 * slow response to an earlier request can never overwrite a newer one, nor land after unmount.
 */
export function startLoad<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  set: (update: (prev: LoadState<T>) => LoadState<T>) => void,
): () => void {
  const ctl = new AbortController();
  let live = true;
  set((s) => ({ ...s, loading: true, error: null }));
  fetcher(ctl.signal).then(
    (data) => {
      if (live) set(() => ({ data, error: null, loading: false }));
    },
    (e: unknown) => {
      if (live) set((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false }));
    },
  );
  return () => {
    live = false;
    ctl.abort();
  };
}

/**
 * Load data for a component: runs `fetcher` on mount and whenever `deps` change, with a stale guard
 * (see startLoad). `reload()` runs it again; `setData` edits the loaded value in place after a write,
 * so a successful save need not refetch. The sibling of usePaged for single-response endpoints.
 */
export function useLoad<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | undefined>>;
} {
  const [state, setState] = useState<LoadState<T>>({ data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);
  // The latest fetcher, so an inline closure does not restart the load on every render; `deps` does.
  const fetchRef = useRef(fetcher);
  useEffect(() => {
    fetchRef.current = fetcher;
  });
  useEffect(
    () => startLoad((signal) => fetchRef.current(signal), setState),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's deps drive the load, plus reload's tick
    [...deps, tick],
  );
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const setData = useCallback<Dispatch<SetStateAction<T | undefined>>>(
    (v) =>
      setState((s) => ({
        ...s,
        data: typeof v === "function" ? (v as (prev: T | undefined) => T | undefined)(s.data) : v,
      })),
    [],
  );
  return { data: state.data, error: state.error, loading: state.loading, reload, setData };
}
