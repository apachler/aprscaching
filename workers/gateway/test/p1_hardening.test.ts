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
