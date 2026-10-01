// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime-neutral interfaces. The gateway's business logic is written against these so it runs
 * unchanged on Cloudflare (D1 / Durable Objects / R2) and on the portable Node/SQLite server.
 * The Cloudflare bindings are structurally compatible; the Node adapter implements them directly.
 * Only room.ts (the Durable Object) depends on real Workers globals.
 */

export interface SqlResult<T = unknown> {
  results: T[];
  meta: { last_row_id: number; changes: number };
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  run<T = unknown>(): Promise<SqlResult<T>>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<SqlResult<T>>;
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
}

/** fetch() execution context — only waitUntil is ever used. */
export interface ExecCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The instance's offline map: one PMTiles archive the operator provides (an R2 object on Cloudflare, a
 * file on Node and Bun), read by byte range so a phone fetches only the tiles of its pack.
 */
export interface TileArchive {
  /** The archive's size and a tag that changes with its content; null when there is no archive. */
  stat(): Promise<{ size: number; etag: string } | null>;
  /** `length` bytes from `offset` (fewer at the end of the archive). */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Media blob store (audio clues etc.) — implemented by R2 on CF and the filesystem on Node. */
export interface MediaStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete?(key: string): Promise<void>;
}

/** Region-room namespace (Durable Object on CF; an in-memory room registry on Node). */
export interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
