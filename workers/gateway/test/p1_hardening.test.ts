// SPDX-License-Identifier: AGPL-3.0-or-later
// P1 go-public hardening: SR-SEC-08 (timing-safe secret compares), SR-SEC-10 (ingest caps),
// SR-SEC-13 (WebAuthn origin/rpId must be configured, never taken from the Origin header).
import { describe, it, expect } from "vitest";
import { IngestBatch, INGEST_BATCH_MAX } from "@aprsweb/shared";
import { timingSafeEqual, secretOk } from "../src/auth.js";
import { handleIngest } from "../src/ingest.js";
import { handlePasskeyRegisterBegin, handlePasskeyLoginBegin } from "../src/auth.js";
import type { Env } from "../src/env.js";

const dbNever = {
  prepare: () => {
    throw new Error("DB must not be touched");
  },
} as unknown;

describe("SR-SEC-08 — constant-time secret comparison", () => {
  it("matches equal strings and rejects unequal ones", () => {
    expect(timingSafeEqual("s3cret", "s3cret")).toBe(true);
    expect(timingSafeEqual("s3cret", "s3creT")).toBe(false);
    expect(timingSafeEqual("short", "longer-string")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("secretOk fails closed on an unset/empty expected secret", () => {
    expect(secretOk("anything", undefined)).toBe(false);
    expect(secretOk("anything", "")).toBe(false);
    expect(secretOk(null, "expected")).toBe(false);
    expect(secretOk("expected", "expected")).toBe(true);
  });
});

describe("SR-SEC-10 — ingest batch + body caps", () => {
  const packet = { src: "OE8APR-9", payload: "=4712.00N/01503.00E>", ts: 1000 };

  it(`the batch schema rejects more than ${INGEST_BATCH_MAX} packets`, () => {
    const over = { packets: Array.from({ length: INGEST_BATCH_MAX + 1 }, () => packet) };
    expect(IngestBatch.safeParse(over).success).toBe(false);
    const at = { packets: Array.from({ length: 3 }, () => packet) };
    expect(IngestBatch.safeParse(at).success).toBe(true);
  });

  it("an oversized Content-Length is refused with 413 before the body is buffered", async () => {
    const req = new Request("http://gw/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(50 * 1024 * 1024) },
      body: "{}",
    });
    const res = await handleIngest(req, { DB: dbNever } as Env, {} as never);
    expect(res.status).toBe(413);
  });
});

describe("SR-SEC-13 — WebAuthn requires configured APP_URL/RP_ID (never the Origin header)", () => {
  const attacker = (path: string) =>
    new Request(`http://gw${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ callsign: "OE8APR" }),
    });

  it("register/begin refuses when APP_URL is unset — no DB write, no attacker-origin binding", async () => {
    const res = await handlePasskeyRegisterBegin(attacker("/auth/passkey/register/begin"), { DB: dbNever } as Env);
    expect(res.status).toBe(503);
  });

  it("login/begin refuses when APP_URL is unset", async () => {
    const res = await handlePasskeyLoginBegin(attacker("/auth/passkey/login/begin"), { DB: dbNever } as Env);
    expect(res.status).toBe(503);
  });

  it("proceeds past the config gate when APP_URL is set (fails later on DB, proving the gate passed)", async () => {
    const env = { DB: dbNever, APP_URL: "https://aprscaching.net" } as Env;
    await expect(handlePasskeyRegisterBegin(attacker("/auth/passkey/register/begin"), env)).rejects.toThrow(
      /DB must not be touched/,
    );
  });
});

// ---- P1b: SR-SEC-11 session expiry + SR-SEC-12 register/finish-only account creation ----
import { sessionExpired, handlePasskeyRegisterFinish } from "../src/auth.js";

describe("SR-SEC-11 — sessions expire server-side", () => {
  const env = {} as Env;
  const DAY = 86_400_000;
  it("a token within its lifetime is honored", () => {
    expect(sessionExpired(Date.now() - 5 * DAY, env, Date.now())).toBe(false);
  });
  it("a token past the 30-day default is rejected even with a valid signature", () => {
    expect(sessionExpired(Date.now() - 31 * DAY, env, Date.now())).toBe(true);
  });
  it("SESSION_TTL_DAYS tunes the lifetime", () => {
    const short = { SESSION_TTL_DAYS: "1" } as Env;
    expect(sessionExpired(Date.now() - 2 * DAY, short, Date.now())).toBe(true);
    expect(sessionExpired(Date.now() - 0.5 * DAY, short, Date.now())).toBe(false);
  });
  it("a future-dated (forged-timestamp) token is rejected", () => {
    expect(sessionExpired(Date.now() + DAY, env, Date.now())).toBe(true);
  });
  it("SESSION_EPOCH revokes every session minted before it", () => {
    const now = Date.now();
    const epochEnv = { SESSION_EPOCH: String(Math.floor(now / 1000) - 60) } as Env;
    expect(sessionExpired(now - 3_600_000, epochEnv, now)).toBe(true); // minted an hour ago < epoch
    expect(sessionExpired(now - 10_000, epochEnv, now)).toBe(false); // minted after the epoch
  });
});

describe("SR-SEC-12 — accounts persist only on register/finish", () => {
  it("register/begin for a NEW callsign writes no accounts row (squatting closed)", async () => {
    const writes: string[] = [];
    const stmt = (sql: string) => ({
      bind: (..._a: unknown[]) => ({
        run: async () => {
          writes.push(sql);
          return {};
        },
        first: async () => null, // no existing account, no session
        all: async () => ({ results: [] }),
      }),
    });
    const db = {
      prepare: stmt,
      batch: async (stmts: unknown[]) => {
        // the batch used by storeChallenge — record what it would write
        for (const s of stmts as { run: () => Promise<unknown> }[]) await s.run();
        return [];
      },
    };
    const env = { DB: db, APP_URL: "https://aprscaching.net" } as unknown as Env;
    const res = await handlePasskeyRegisterBegin(
      new Request("http://gw/auth/passkey/register/begin", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" },
        body: JSON.stringify({ callsign: "W1AW" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.includes("INSERT INTO accounts"))).toBe(false); // the squat is gone
    expect(writes.some((w) => w.includes("auth_challenges"))).toBe(true); // ceremony stashed
  });

  it("register/finish with no pending ceremony is refused (nothing to bind)", async () => {
    const db = {
      prepare: (_sql: string) => ({
        bind: () => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }),
      }),
      batch: async () => [],
    };
    const env = { DB: db, APP_URL: "https://aprscaching.net" } as unknown as Env;
    const res = await handlePasskeyRegisterFinish(
      new Request("http://gw/auth/passkey/register/finish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callsign: "W1AW", credential: { response: { clientDataJSON: "e30" } } }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});
