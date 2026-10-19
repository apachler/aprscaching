// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";

interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Drive a keyset-paginated list: fetch the first page on mount/dep-change, then append
 * older pages via loadMore() following the server's opaque cursor. The fetcher maps a wire response
 * (named array + nextCursor/hasMore) into a PageResult. Behavior, not appearance — pairs with the
 * <LoadMore> button (a CSS-styled real <button>).
 *
 * Every reset (mount, a dep change, reload) starts a new generation, and only answers of the current one are
 * applied: a slower answer for an earlier filter, or a Load more still in flight when the list resets, is
 * dropped. refresh() fetches the first page again and merges it into the loaded pages by `keyOf`, so a poll
 * picks up new and changed rows without throwing away the older pages the user loaded.
 */
export function usePaged<T>(
  fetcher: (cursor: string | null) => Promise<PageResult<T>>,
  deps: unknown[],
  opts: { keyOf?: (item: T) => string | number } = {},
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  // the latest fetcher and key, for refresh(); `deps` alone drives the loads
  const fetchRef = useRef(fetcher);
  const keyOf = useRef(opts.keyOf);
  const itemsRef = useRef(items);
  useEffect(() => {
    fetchRef.current = fetcher;
    keyOf.current = opts.keyOf;
    itemsRef.current = items;
  });

  const load = useCallback(async (from: string | null, reset: boolean) => {
    const g = reset ? ++gen.current : gen.current;
    setLoading(true);
    setError(null);
    try {
      const r = await fetcher(from);
      if (g !== gen.current) return;
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
      setCursor(r.nextCursor);
      setHasMore(r.hasMore);
    } catch (e) {
      if (g === gen.current) setError((e as Error).message);
    } finally {
      if (g === gen.current) setLoading(false);
    }
    // caller-supplied `deps` drive refetch; `fetcher` is intentionally not tracked (would refetch on every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void load(null, true);
  }, [load]);

  const loadMore = useCallback(() => {
    if (hasMore && !loading) void load(cursor, false);
  }, [hasMore, loading, cursor, load]);
  const reload = useCallback(() => {
    void load(null, true);
  }, [load]);

  // The first page again. When its oldest row is one already loaded, it is merged in front: its rows replace
  // their loaded copies, the older loaded rows stay, and the cursor still points past the oldest of them.
  // Otherwise it replaces the list with its own cursor: either it is the whole list, or more than a page
  // arrived since and a merge would leave a gap no cursor reaches.
  const refresh = useCallback(() => {
    const key = keyOf.current;
    if (!key) {
      void load(null, true);
      return;
    }
    const g = gen.current;
    fetchRef.current(null).then(
      (r) => {
        if (g !== gen.current) return;
        const last = r.items[r.items.length - 1];
        const reaches = r.hasMore && last !== undefined && itemsRef.current.some((it) => key(it) === key(last));
        if (!reaches) {
          setItems(r.items);
          setCursor(r.nextCursor);
          setHasMore(r.hasMore);
          return;
        }
        setItems((prev) => {
          const fresh = new Set(r.items.map(key));
          return [...r.items, ...prev.filter((it) => !fresh.has(key(it)))];
        });
      },
      () => {
        /* a failed poll keeps the loaded list; the next one tries again */
      },
    );
  }, [load]);
  return { items, hasMore, loading, error, loadMore, reload, refresh };
}
