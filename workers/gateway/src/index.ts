// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import type { ExecCtx, MediaStore } from "./runtime.js";
import { handle, runScheduled, runFrequentSync } from "./app.js";
export { RegionRoom } from "./room.js";
export { handle, runScheduled, runFrequentSync, json } from "./app.js";

/** Adapt a Cloudflare R2 bucket binding to the runtime-neutral MediaStore interface. */
function adaptR2(bucket: any): MediaStore | undefined {
  if (!bucket) return undefined;
  return {
    put: (key, bytes, contentType) => bucket.put(key, bytes, { httpMetadata: { contentType } }).then(() => undefined),
    get: async (key) => {
      const o = await bucket.get(key);
      if (!o) return null;
      return {
        bytes: new Uint8Array(await o.arrayBuffer()),
        contentType: o.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },
    delete: (key) => bucket.delete(key).then(() => undefined),
  };
}

export default {
  fetch(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
    return handle(req, { ...env, MEDIA: adaptR2((env as any).MEDIA) }, ctx);
  },
  scheduled(event: { cron?: string }, env: Env): Promise<void> {
    // SR-RT-01: the two crons do different work. Only the nightly `0 4` cron runs the full TTL/rollup/
    // digest job; the frequent `*/15` cron does the cheap federation sync. Running the full job 96×/day
    // was a D1 rows-read cost bug and diverged the digest cadence from Node/Bun.
    return event.cron === "0 4 * * *" ? runScheduled(env) : runFrequentSync(env);
  },
};
