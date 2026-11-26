// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * each-frame.ts — hands each frame of one read to its consumer. A socket's read can carry many frames; a consumer
 * that throws on one of them (a bug, or input no one foresaw) loses that frame only. The error is logged under
 * the port's own log, and the frames after it in the same read are still delivered — rather than the throw
 * unwinding the data handler and the process-wide handler swallowing the rest of the chunk.
 */
export function eachFrame<T>(frames: Iterable<T>, consume: (f: T) => void, report: (msg: string) => void): void {
  for (const f of frames) {
    try {
      consume(f);
    } catch (e) {
      report(`one received frame was dropped: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }
}
