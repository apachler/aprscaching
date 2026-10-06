// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * mediadeletions.ts — media objects that must leave the object store once their index rows are gone. An erasure or
 * a moderation removal queues the objects in the same batch that drops the rows (`media_deletions`), then deletes
 * them. A crash or a store error between the two leaves the queue, which the nightly job works off, so an erased
 * person's uploads never stay behind in the store.
 */
import type { Env } from "./env.js";
import { nowS } from "./util/time.js";

/** The statements that queue `keys` for deletion from the object store, for the batch that drops their rows. */
export function queueMediaDeletes(env: Env, keys: string[]) {
  const at = nowS();
  return keys.map((k) =>
    env.DB.prepare("INSERT OR IGNORE INTO media_deletions (media_key, queued_at) VALUES (?, ?)").bind(k, at),
  );
}

/**
 * Delete queued objects from the store: `keys`, or every queued one. A key leaves the queue once the store deleted
 * it; one the store refused stays for the next run. An instance with no object store has nothing to delete.
 */
export async function finishMediaDeletes(env: Env, keys?: string[]): Promise<void> {
  const queued =
    keys ??
    (
      await env.DB.prepare("SELECT media_key FROM media_deletions ORDER BY queued_at LIMIT 1000").all<{
        media_key: string;
      }>()
    ).results.map((r) => r.media_key);
  for (const k of queued) {
    try {
      await env.MEDIA?.delete?.(k);
    } catch {
      continue; // the store refused it: the next run tries again
    }
    await env.DB.prepare("DELETE FROM media_deletions WHERE media_key = ?").bind(k).run();
  }
}
