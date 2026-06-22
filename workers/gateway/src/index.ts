import type { Env } from "./env.js";
import type { ExecCtx } from "./runtime.js";
import { handle, runScheduled } from "./app.js";
export { RegionRoom } from "./room.js";
export { handle, runScheduled, json } from "./app.js";

export default {
  fetch(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
    return handle(req, env, ctx);
  },
  scheduled(_event: unknown, env: Env): Promise<void> {
    return runScheduled(env);
  },
};
