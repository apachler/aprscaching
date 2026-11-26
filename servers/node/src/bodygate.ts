// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Request bodies on the Node and Bun servers. A body is handed to the gateway unread, as a stream the handler
 * pulls when it reads it: an unknown path, a refused method and a handler that checks its caller first answer
 * without the body ever leaving the socket. What a handler does read is metered here:
 *
 * - past {@link BODY_MAX_BYTES} the stream fails with {@link BodyTooLarge}, answered 413;
 * - a body past {@link BODY_FREE_BYTES} — larger than any JSON form the app sends — takes one of a fixed number of
 *   slots, overall and per client address, held until the body ends or the request is answered. Without a free slot the
 *   stream fails with {@link BodyBusy}, answered 503 with Retry-After.
 *
 * The slots bound what bodies in flight can pin to {@link BODY_SLOTS} × BODY_MAX_BYTES plus the small ones; a
 * client that opens many connections from one address holds at most {@link BODY_SLOTS_PER_CLIENT} of them. A client
 * that sends its body slowly holds its slot for as long as it keeps sending.
 */
import { BODY_MAX_BYTES } from "./host.js";

export { BODY_MAX_BYTES };
/** A body up to this size needs no slot: every JSON form and ingest batch of the app fits. */
export const BODY_FREE_BYTES = 64 * 1024;
/** Large bodies read at once, over every client. */
export const BODY_SLOTS = 8;
/** Large bodies read at once from one client address. */
export const BODY_SLOTS_PER_CLIENT = 2;

/** The body passed BODY_MAX_BYTES: reading stopped, the request is answered 413. */
export class BodyTooLarge extends Error {
  constructor() {
    super("request body too large");
  }
}
/** No slot was free for a large body: reading stopped, the request is answered 503. */
export class BodyBusy extends Error {
  constructor() {
    super("too many uploads at once, try again shortly");
  }
}

/** The slots large bodies hold while they are read, overall and per client address. */
export class BodyGate {
  private total = 0;
  private readonly perClient = new Map<string, number>();
  constructor(
    readonly slots = BODY_SLOTS,
    readonly slotsPerClient = BODY_SLOTS_PER_CLIENT,
  ) {}

  /** Take a slot for `client`, or false when none is free. */
  acquire(client: string): boolean {
    const held = this.perClient.get(client) ?? 0;
    if (this.total >= this.slots || held >= this.slotsPerClient) return false;
    this.total++;
    this.perClient.set(client, held + 1);
    return true;
  }

  release(client: string): void {
    const held = this.perClient.get(client) ?? 0;
    if (held <= 0) return;
    this.total--;
    if (held === 1) this.perClient.delete(client);
    else this.perClient.set(client, held - 1);
  }

  /** Slots held now, overall. */
  get inUse(): number {
    return this.total;
  }
}

/** The process's one gate, shared by every listener of the server (the plain and the https one). */
export const sharedBodyGate = new BodyGate();

/** A body handed to the gateway, and what became of it once the handler is done. */
export interface MeteredBody {
  stream: ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Why the stream failed (too large, no slot), or null. */
  failure(): BodyTooLarge | BodyBusy | null;
  /** Whether the source was read to its end. */
  complete(): boolean;
  /**
   * The request is answered: give the slot back and stop reading. A handler may leave a body half-read — a copy of
   * it read to a cap, the original never — so the end of the request, not of the body, is what frees the slot.
   */
  finish(): void;
}

/**
 * Meter `source` — the request's body chunks, pulled only as the handler reads — for `client`, against `gate`.
 * The slot a large body takes is released when it ends, fails or is cancelled. Cancelling stops pulling but
 * leaves the source to its owner: the server closes the connection under an unread rest.
 */
export function meterBody(
  source: AsyncIterator<Uint8Array>,
  client: string,
  gate: BodyGate,
  max = BODY_MAX_BYTES,
): MeteredBody {
  let read = 0;
  let slot = false;
  let ended = false;
  let failed: BodyTooLarge | BodyBusy | null = null;
  let finished = false;
  const release = () => {
    if (slot) gate.release(client);
    slot = false;
  };
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (finished) {
        controller.error(new Error("the request was already answered"));
        return;
      }
      let next: IteratorResult<Uint8Array>;
      try {
        next = await source.next();
      } catch (e) {
        release();
        controller.error(e);
        return;
      }
      // answered while this read waited: take no slot for what arrived
      if (finished) {
        controller.error(new Error("the request was already answered"));
        return;
      }
      if (next.done) {
        ended = true;
        release();
        controller.close();
        return;
      }
      read += next.value.byteLength;
      if (read > max) failed = new BodyTooLarge();
      else if (read > BODY_FREE_BYTES && !slot && !(slot = gate.acquire(client))) failed = new BodyBusy();
      if (failed) {
        release();
        controller.error(failed);
        return;
      }
      controller.enqueue(new Uint8Array(next.value));
    },
    cancel() {
      release();
    },
  });
  return {
    stream,
    failure: () => failed,
    complete: () => ended,
    finish: () => {
      finished = true;
      release();
    },
  };
}

/** The answer to a body the meter stopped: 413 or 503, closing the connection, never the handler's own. */
export function bodyFailureResponse(e: BodyTooLarge | BodyBusy): Response {
  const busy = e instanceof BodyBusy;
  return new Response(JSON.stringify({ error: e.message }), {
    status: busy ? 503 : 413,
    headers: { "content-type": "application/json", connection: "close", ...(busy ? { "retry-after": "5" } : {}) },
  });
}
