// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The offline log queue. A log that cannot reach the instance waits here, signed and timed when it was
 * made, and is sent when the connection returns. Nothing in it is dropped without the user choosing to:
 *
 * - no connection: it stays queued and goes with the next flush;
 * - a server or rate-limit error (5xx, 408, 429): it stays queued and is retried with backoff;
 * - sent under another player's session (the instance answers that the session is not the entry's call): it
 *   stays queued for its own player, and the rest wait with it;
 * - a refusal (any other 4xx — a key no longer registered, an archived cache): it moves to the
 *   needs-attention list with the server's reason, where the user retries it, edits its comment
 *   (the signature does not cover the comment) or discards it.
 *
 * Each entry belongs to the player whose session queued it, and goes out only under that player's session: the
 * send carries whichever session cookie is current, so on a shared device another player's flush would credit
 * them with it. Another player's entries wait, unlisted, until their owner signs in again.
 *
 * Pure apart from the storage and the sender it is given, so it is tested without a browser. The app keeps
 * it in IndexedDB (offline/store.ts), where the service worker can read it too.
 */

/** The fields a log carries; the queue treats the body as opaque apart from its comment. */
export interface QueuedBody {
  logType: string;
  comment?: string;
  [k: string]: unknown;
}

export interface QueuedLog<B extends QueuedBody = QueuedBody> {
  cacheId: number;
  body: B;
  /** The signed-in callsign that queued it: only a session of that call sends it or lists it. */
  owner: string;
  /** The cache, as shown in the list (code and title), when the form knew it. */
  label?: string;
  /** The instance the log was signed for: it is sent there and nowhere else (the signature names it). */
  instance?: string;
  /**
   * What the entry is: a log (the default), or a stage unlock made offline from a pack, which the instance
   * confirms on sync like any other (`stageNo`; the body carries the scanned code).
   */
  kind?: "log" | "unlock";
  stageNo?: number;
  /** When the log entered the queue (ms). */
  queuedAt: number;
  /** Failed sends that count toward the backoff. */
  attempts?: number;
  /** Not sent before this time (ms), after a server error. */
  nextAt?: number;
}

export interface AttentionLog<B extends QueuedBody = QueuedBody> extends QueuedLog<B> {
  /** The server's reason for refusing it. */
  reason: string;
  status: number;
  /** When it was refused (ms). */
  refusedAt: number;
}

export interface QueueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** What a failed send was: the network, a server error to retry, another player's session, or a refusal. */
export type SendFailure =
  { kind: "offline" } | { kind: "retry" } | { kind: "held" } | { kind: "refused"; status: number; reason: string };

const QUEUE_KEY = "acs.logqueue";
const ATTENTION_KEY = "acs.logqueue.attention";

const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** The wait before the next try after `attempts` failed ones: 30 s doubling, at most 30 min. */
export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

async function read<T>(store: QueueStore, key: string): Promise<T[]> {
  try {
    const v = JSON.parse((await store.get(key)) || "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
// a failed write throws: the caller must not report a log as kept when it was not
const write = (store: QueueStore, key: string, items: unknown[]) => store.set(key, JSON.stringify(items));

const sameCall = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

/** The entries `owner` queued; none with nobody signed in. */
export const ownedBy = <T extends QueuedLog<QueuedBody>>(items: T[], owner: string | null): T[] =>
  items.filter((i) => sameCall(i.owner, owner));

export const loadQueue = <B extends QueuedBody>(store: QueueStore) => read<QueuedLog<B>>(store, QUEUE_KEY);
export const loadAttention = <B extends QueuedBody>(store: QueueStore) => read<AttentionLog<B>>(store, ATTENTION_KEY);

export async function enqueue<B extends QueuedBody>(
  store: QueueStore,
  item: Omit<QueuedLog<B>, "queuedAt">,
  now: number,
): Promise<void> {
  await write(store, QUEUE_KEY, [...(await loadQueue<B>(store)), { ...item, queuedAt: now }]);
}

export interface FlushResult {
  sent: number;
  /** Moved to needs-attention by this flush. */
  refused: number;
  /** The earliest time (ms) a backed-off log may go again, when one waits. */
  nextAt?: number;
}

/**
 * Send what is due. `send` resolves when the instance accepted the log and rejects with a
 * {@link SendFailure} otherwise. With no connection the rest waits for the next flush.
 */
export async function flush<B extends QueuedBody>(
  store: QueueStore,
  send: (item: QueuedLog<B>) => Promise<void>,
  now: number,
  /** The instance this flush reaches: a log signed for another one waits for it. */
  instance: string | undefined,
  /** The signed-in callsign whose session the sends carry: another player's entries wait for theirs. */
  owner: string | null,
): Promise<FlushResult> {
  const queue = await loadQueue<B>(store);
  const keep: QueuedLog<B>[] = [];
  const refused: AttentionLog<B>[] = [];
  let sent = 0;
  // no connection, or a session that is not the owner's: the rest wait for the next flush
  let stop = false;
  for (const item of queue) {
    const elsewhere = instance != null && item.instance != null && item.instance !== instance;
    if (stop || elsewhere || !sameCall(item.owner, owner) || (item.nextAt != null && item.nextAt > now)) {
      keep.push(item);
      continue;
    }
    try {
      await send(item);
      sent++;
    } catch (e) {
      const f = e as SendFailure;
      if (f?.kind === "refused") {
        const { nextAt: _n, attempts: _a, ...rest } = item;
        refused.push({ ...rest, reason: f.reason, status: f.status, refusedAt: now });
      } else if (f?.kind === "retry") {
        const attempts = (item.attempts ?? 0) + 1;
        keep.push({ ...item, attempts, nextAt: now + backoffMs(attempts) });
      } else {
        stop = true;
        keep.push(item);
      }
    }
  }
  // A log added while this flush was sending is in the store but not in `queue`: keep it too.
  const added = (await loadQueue<B>(store)).filter(
    (q) => !queue.some((o) => o.queuedAt === q.queuedAt && o.cacheId === q.cacheId),
  );
  await write(store, QUEUE_KEY, [...keep, ...added]);
  if (refused.length) await write(store, ATTENTION_KEY, [...(await loadAttention<B>(store)), ...refused]);
  const waits = keep.map((i) => i.nextAt).filter((t): t is number => t != null);
  return { sent, refused: refused.length, ...(waits.length && { nextAt: Math.min(...waits) }) };
}

/**
 * Which log an entry is: its cache and when it was queued. A retry queues it again under a new time, so the
 * key follows one entry while the list around it moves (another retry, a re-refusal, a second tab); a
 * position in the list would point at whichever entry slid into it.
 */
export interface LogKey {
  cacheId: number;
  queuedAt: number;
}
const isKey = (q: QueuedLog, k: LogKey) => q.cacheId === k.cacheId && q.queuedAt === k.queuedAt;

/** Put a refused log back in the queue, with a new comment when given; it goes with the next flush. */
export async function retryAttention(store: QueueStore, key: LogKey, now: number, comment?: string): Promise<void> {
  const list = await loadAttention(store);
  const item = list.find((a) => isKey(a, key));
  if (!item) return;
  const { reason: _r, status: _s, refusedAt: _t, ...rest } = item;
  const body = comment === undefined ? rest.body : { ...rest.body, comment: comment.trim() || undefined };
  await write(store, QUEUE_KEY, [...(await loadQueue(store)), { ...rest, body, queuedAt: now }]);
  await write(
    store,
    ATTENTION_KEY,
    list.filter((a) => a !== item),
  );
}

/** Remove a waiting log at the user's request (it was sent another way, e.g. by radio). */
export async function removeQueued(store: QueueStore, cacheId: number, queuedAt: number): Promise<void> {
  await write(
    store,
    QUEUE_KEY,
    (await loadQueue(store)).filter((q) => !(q.cacheId === cacheId && q.queuedAt === queuedAt)),
  );
}

/** Remove a refused log for good, at the user's request. */
export async function discardAttention(store: QueueStore, key: LogKey): Promise<void> {
  await write(
    store,
    ATTENTION_KEY,
    (await loadAttention(store)).filter((a) => !isKey(a, key)),
  );
}
