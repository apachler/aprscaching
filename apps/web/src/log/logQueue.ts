// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The offline log queue. A log that cannot reach the instance waits here, signed and timed when it was
 * made, and is sent when the connection returns. Nothing in it is dropped without the user choosing to:
 *
 * - no connection: it stays queued and goes with the next flush;
 * - a server or rate-limit error (5xx, 408, 429): it stays queued and is retried with backoff;
 * - a refusal (any other 4xx — a key no longer registered, an archived cache): it moves to the
 *   needs-attention list with the server's reason, where the user retries it, edits its comment
 *   (the signature does not cover the comment) or discards it.
 *
 * Pure apart from the storage and the sender it is given, so it is tested without a browser.
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
  /** The cache, as shown in the list (code and title), when the form knew it. */
  label?: string;
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
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** What a failed send was: the network, a server error to retry, or a refusal. */
export type SendFailure = { kind: "offline" } | { kind: "retry" } | { kind: "refused"; status: number; reason: string };

export const QUEUE_KEY = "acs.logqueue";
export const ATTENTION_KEY = "acs.logqueue.attention";

const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** The wait before the next try after `attempts` failed ones: 30 s doubling, at most 30 min. */
export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

function read<T>(store: QueueStore, key: string): T[] {
  try {
    const v = JSON.parse(store.get(key) || "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
function write(store: QueueStore, key: string, items: unknown[]): void {
  try {
    store.set(key, JSON.stringify(items));
  } catch {
    /* storage full or unavailable: the in-memory copy is lost with the page */
  }
}

export const loadQueue = <B extends QueuedBody>(store: QueueStore) => read<QueuedLog<B>>(store, QUEUE_KEY);
export const loadAttention = <B extends QueuedBody>(store: QueueStore) => read<AttentionLog<B>>(store, ATTENTION_KEY);

export function enqueue<B extends QueuedBody>(store: QueueStore, item: Omit<QueuedLog<B>, "queuedAt">, now: number) {
  write(store, QUEUE_KEY, [...loadQueue<B>(store), { ...item, queuedAt: now }]);
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
): Promise<FlushResult> {
  const queue = loadQueue<B>(store);
  const keep: QueuedLog<B>[] = [];
  const refused: AttentionLog<B>[] = [];
  let sent = 0;
  let offline = false;
  for (const item of queue) {
    if (offline || (item.nextAt != null && item.nextAt > now)) {
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
        offline = true;
        keep.push(item);
      }
    }
  }
  write(store, QUEUE_KEY, keep);
  if (refused.length) write(store, ATTENTION_KEY, [...loadAttention<B>(store), ...refused]);
  const waits = keep.map((i) => i.nextAt).filter((t): t is number => t != null);
  return { sent, refused: refused.length, ...(waits.length && { nextAt: Math.min(...waits) }) };
}

/** Put a refused log back in the queue, with a new comment when given; it goes with the next flush. */
export function retryAttention(store: QueueStore, index: number, now: number, comment?: string): void {
  const list = loadAttention(store);
  const item = list[index];
  if (!item) return;
  const { reason: _r, status: _s, refusedAt: _t, ...rest } = item;
  const body = comment === undefined ? rest.body : { ...rest.body, comment: comment.trim() || undefined };
  write(
    store,
    ATTENTION_KEY,
    list.filter((_, i) => i !== index),
  );
  write(store, QUEUE_KEY, [...loadQueue(store), { ...rest, body, queuedAt: now }]);
}

/** Remove a refused log for good, at the user's request. */
export function discardAttention(store: QueueStore, index: number): void {
  write(
    store,
    ATTENTION_KEY,
    loadAttention(store).filter((_, i) => i !== index),
  );
}
