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

  it("reports the newest applied migration as the schema", async () => {
    const tables: Record<string, string> = {};
    const db = {
      prepare: (sql: string) => ({
        first: async () => {
          if (sql === "SELECT 1 AS ok") return { ok: 1 };
          const t = /FROM (\w+)/.exec(sql)?.[1] ?? "";
          if (!(t in tables)) throw new Error(`no such table: ${t}`);
          return { name: tables[t] };
        },
      }),
    };
    const res = await route(get("/health"), { DB: db } as unknown as Env, ctx);
    expect(await res.json()).toMatchObject({ ok: true, schema: null });
    tables._migrations = "0008_eight.sql";
    const again = await route(get("/health"), { DB: db } as unknown as Env, ctx);
    expect(await again.json()).toMatchObject({ schema: "0008_eight.sql" });
  });

  it("checks an ingest credential without writing anything, reading only the trusted sites", async () => {
    let touched = false;
    const env = {
      INGEST_SECRET: "the-ingest-secret-123",
      INSTANCE: "oe.test",
      DB: {
        prepare: (sql: string) => {
          if (!/^\s*SELECT\b/i.test(sql) || !/trusted_sites/.test(sql)) touched = true;
          return { all: async () => ({ results: [{ site: "oe8abc-10" }] }) };
        },
      },
    } as unknown as Env;
    const check = (secret?: string) =>
      route(new Request("http://gw/ingest/check", { headers: secret ? { "x-ingest-secret": secret } : {} }), env, ctx);
    const ok = await check("the-ingest-secret-123");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      instance: "oe.test",
      serviceCall: "APRSCG",
      sites: ["OE8ABC-10"],
      box: null,
    });
    expect((await check("wrong")).status).toBe(401);
    expect((await check()).status).toBe(401);
    expect(touched).toBe(false);
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
