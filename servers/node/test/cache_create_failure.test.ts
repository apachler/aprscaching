// SPDX-License-Identifier: AGPL-3.0-or-later
// A cache insert that fails answers with a generic error: the database's message stays in the server log.
import { describe, it, expect, vi } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

describe("POST /api/caches when the insert fails", () => {
  it("answers 500 without the database's message, and logs it", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "oe8own@example.test", "OE8OWN");
    expect(s.status).toBe(200);
    await env.DB.prepare(
      `INSERT INTO callsign_verifications (callsign, method, status, attempts, created_at, verified_at)
       VALUES ('OE8OWN', 'operator', 'verified', 0, 0, 0) ON CONFLICT(callsign) DO NOTHING`,
    ).run();
    await env.DB.prepare(
      "CREATE TRIGGER fail_cache BEFORE INSERT ON caches BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: caches.difficulty'); END",
    ).run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await call(
        env,
        "POST",
        "/api/caches",
        { title: "Oak", type: "traditional", lat: 47.07, lon: 15.42 },
        { cookie: s.cookie },
      );
      expect(r.status).toBe(500);
      expect(r.data).toEqual({ error: "create failed" });
      expect(logged.mock.calls.flat().map(String).join(" ")).toContain("caches.difficulty");
    } finally {
      logged.mockRestore();
    }
  });
});
