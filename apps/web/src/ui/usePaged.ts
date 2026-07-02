// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";

export interface PageResult<T> { items: T[]; nextCursor: string | null; hasMore: boolean }

/**
 * Drive a keyset-paginated list (docs/design/11): fetch the first page on mount/dep-change, then append
 * older pages via loadMore() following the server's opaque cursor. The fetcher maps a wire response
 * (named array + nextCursor/hasMore) into a PageResult. Behavior, not appearance — pairs with the
 * <LoadMore> button (a CSS-styled real <button>).
 */
export function usePaged<T>(fetcher: (cursor: string | null) => Promise<PageResult<T>>, deps: unknown[]) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async (from: string | null, reset: boolean) => {
    setLoading(true); setError(null);
    try {
      const r = await fetcher(from);
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
      setCursor(r.nextCursor); setHasMore(r.hasMore);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, deps);

  useEffect(() => { void load(null, true); }, [load]);

  const loadMore = useCallback(() => { if (hasMore && !loading) void load(cursor, false); }, [hasMore, loading, cursor, load]);
  const reload = useCallback(() => { void load(null, true); }, [load]);
  return { items, hasMore, loading, error, loadMore, reload };
}
