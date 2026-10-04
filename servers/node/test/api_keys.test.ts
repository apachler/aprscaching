// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-API keys belong to a signed-in account: it creates them up to the instance's cap, sees each key in full
// only once, and revokes them; the sysop lists and revokes every key. The database holds no usable key.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe("an account's API keys", () => {
  it("are created by a signed-in account only, and anonymous minting is gone", async () => {
    const env = authEnv();
    expect((await call(env, "POST", "/api/keys", { name: "script" })).status).toBe(401);
    expect((await call(env, "GET", "/api/keys")).status).toBe(401);
    const old = await call(env, "POST", "/api/v1/keys", { label: "x" });
    expect(old.status).toBe(410);
    expect(old.data.error).toMatch(/Settings → Developer/);
  });

  it("shows the key once, stores only its hash, and raises the rate limit", async () => {
    const env = authEnv({ API_RATE_ANON: "1" });
    const me = await emailSignup(env, "keys@example.test", "DL1KEY");
    const made = await call(env, "POST", "/api/keys", { name: "  my logger  " }, { cookie: me.cookie });
    expect(made.status).toBe(201);
    expect(made.data).toMatchObject({ name: "my logger", lastUsedAt: null });
    const key = made.data.key as string;
    expect(key).toMatch(/^acg_[0-9a-f]{32}$/);
    expect(made.data.prefix).toBe(key.slice(0, 12));

    const stored = await env.DB.prepare("SELECT key_hash, prefix FROM api_keys").all<Record<string, string>>();
    expect(JSON.stringify(stored.results)).not.toContain(key);

    const list = await call(env, "GET", "/api/keys", undefined, { cookie: me.cookie });
    expect(list.data.cap).toBe(5);
    expect(list.data.keys).toHaveLength(1);
    expect(JSON.stringify(list.data)).not.toContain(key);

    // past the anonymous budget of one, the key still reads
    const ip = "198.51.100.40";
    expect((await call(env, "GET", "/api/v1/activity", undefined, {}, ip)).status).toBe(200);
    expect((await call(env, "GET", "/api/v1/activity", undefined, {}, ip)).status).toBe(429);
    expect((await call(env, "GET", "/api/v1/activity", undefined, bearer(key), ip)).status).toBe(200);
    const info = await call(env, "GET", "/api/v1/key", undefined, bearer(key), ip);
    expect(info.status).toBe(200);
    expect(info.data).toMatchObject({ name: "my logger", prefix: key.slice(0, 12), tier: "free" });
    expect(info.data.lastUsedAt).toBeGreaterThan(0);
    expect((await call(env, "GET", "/api/v1/key", undefined, bearer("acg_nope"), "198.51.100.41")).status).toBe(401);
  });

  it("refuses a nameless key and a key past the cap", async () => {
    const env = authEnv({ API_KEYS_PER_ACCOUNT: "2" });
    const me = await emailSignup(env, "cap@example.test", "DL1CAP");
    const make = (name: string) => call(env, "POST", "/api/keys", { name }, { cookie: me.cookie });
    expect((await make(" ")).status).toBe(400);
    expect((await make("x".repeat(61))).status).toBe(400);
    expect((await make("one")).status).toBe(201);
    expect((await make("two")).status).toBe(201);
    const third = await make("three");
    expect(third.status).toBe(409);
    expect(third.data.error).toMatch(/revoke one/);
  });

  it("revokes the account's own key, and not someone else's", async () => {
    const env = authEnv();
    const a = await emailSignup(env, "a@example.test", "DL1AAA");
    const b = await emailSignup(env, "b@example.test", "DL1BBB");
    const made = await call(env, "POST", "/api/keys", { name: "a's" }, { cookie: a.cookie });
    const id = made.data.id as number;
    expect((await call(env, "DELETE", `/api/keys/${id}`, undefined, { cookie: b.cookie })).status).toBe(404);
    expect((await call(env, "DELETE", `/api/keys/${id}`, undefined, { cookie: a.cookie })).status).toBe(200);
    expect((await call(env, "GET", "/api/v1/key", undefined, bearer(made.data.key))).status).toBe(401);
    expect((await call(env, "GET", "/api/keys", undefined, { cookie: a.cookie })).data.keys).toEqual([]);
  });
});

describe("the sysop's view of API keys", () => {
  it("lists every key with its owner and revokes any; a member is refused", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8SYS" });
    const sysop = await emailSignup(env, "sysop@example.test", "OE8SYS");
    await operatorVerify(env, "OE8SYS");
    const member = await emailSignup(env, "m@example.test", "DL1MEM");
    const made = await call(env, "POST", "/api/keys", { name: "scraper" }, { cookie: member.cookie });

    expect((await call(env, "GET", "/api/admin/api-keys", undefined, { cookie: member.cookie })).status).toBe(403);
    const list = await call(env, "GET", "/api/admin/api-keys", undefined, { cookie: sysop.cookie });
    expect(list.status).toBe(200);
    expect(list.data.keys).toEqual([expect.objectContaining({ name: "scraper", owner: "DL1MEM" })]);
    expect(JSON.stringify(list.data)).not.toContain(made.data.key);

    const id = made.data.id as number;
    expect((await call(env, "DELETE", `/api/admin/api-keys/${id}`, undefined, { cookie: member.cookie })).status).toBe(
      403,
    );
    expect((await call(env, "DELETE", `/api/admin/api-keys/${id}`, undefined, { cookie: sysop.cookie })).status).toBe(
      200,
    );
    expect((await call(env, "GET", "/api/keys", undefined, { cookie: member.cookie })).data.keys).toEqual([]);
  });
});
