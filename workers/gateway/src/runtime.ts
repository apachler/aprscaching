// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime-neutral interfaces. The gateway's business logic is written against these so it runs
 * unchanged on the Node server and the Bun server, which implement them: the database over a
 * synchronous SQLite driver (servers/node/src/d1.ts), media and the offline map on the filesystem, and
 * the live rooms in memory (rooms-core.ts).
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
 * The instance's offline map: one PMTiles archive the operator provides (a file on the server), read by
 * byte range so a phone fetches only the tiles of its pack.
 */
export interface TileArchive {
  /** The archive's size and a tag that changes with its content; null when there is no archive. */
  stat(): Promise<{ size: number; etag: string } | null>;
  /** `length` bytes from `offset` (fewer at the end of the archive). */
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
}

/** Media blob store (audio clues etc.) — implemented on the filesystem (servers/node/src/media.ts). */
export interface MediaStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete?(key: string): Promise<void>;
}

/** Region rooms — the in-memory room registry (rooms-core.ts); a region's room is reached by a fetch-shaped call. */
export interface RoomNamespace {
  get(region: string): { fetch(req: Request): Promise<Response> };
}
