// SPDX-License-Identifier: MIT
/**
 * Keyset (cursor) pagination contract. Linear, append-heavy lists (logbook, activity,
 * messages, alerts) page by an opaque cursor over (orderingKey, id) — never OFFSET, which is slow
 * on big tables and skips/duplicates rows when new items land mid-scroll. Responses are ADDITIVE:
 * the existing named array stays, and `nextCursor` + `hasMore` are added alongside it.
 */
export interface PageInfo {
  /** Opaque cursor to pass back as ?cursor= for the next page; null when there are no more rows. */
  nextCursor: string | null;
  /** True when another page exists (i.e. nextCursor is non-null). */
  hasMore: boolean;
}

/** A generic page envelope for endpoints whose response has no named array of its own. */
export interface Page<T> extends PageInfo {
  items: T[];
}
