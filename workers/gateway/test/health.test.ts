// SPDX-License-Identifier: AGPL-3.0-or-later
// /health is a readiness probe by default: a gateway whose DB is unreachable is UP but not READY, and
// must report 503 so an orchestrator holds traffic until it can actually serve. `?live` is the cheap
// liveness escape hatch (process-up only, no DB) for aggressive load-balancer polling.
import { describe, it, expect } from "vitest";
import { route } from "../src/app.js";
import type { Env } from "../src/env.js";
import type { ExecCtx } from "../src/runtime.js";

const ctx = {} as ExecCtx;
const get = (path: string) => new Request(`http://gw${path}`, { method: "GET" });
const okDb = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
const downDb = {
  prepare: () => ({
    first: async () => {
      throw new Error("no such table / connection refused");
    },
  }),
};

describe("/health readiness probe", () => {
  it("returns 200 + db:up when the database answers", async () => {
    const env = { DB: okDb, INSTANCE: "oe.test" } as unknown as Env;
    const res = await route(get("/health"), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, db: "up", instance: "oe.test" });
  });

  it("returns 503 + db:down when the database is unreachable (traffic held)", async () => {
    const env = { DB: downDb } as unknown as Env;
    const res = await route(get("/health"), env, ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: "down" });
  });

  it("?live is a pure liveness check — 200 without touching the DB", async () => {
    let touched = false;
    const env = {
      DB: {
        prepare: () => {
          touched = true;
          return { first: async () => ({}) };
        },
      },
    } as unknown as Env;
    const res = await route(get("/health?live"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, live: true });
    expect(touched).toBe(false);
  });
});
