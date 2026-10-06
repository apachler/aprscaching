// SPDX-License-Identifier: AGPL-3.0-or-later
// Instance settings: the sysop sets the policy values of the instance in Instance admin, stored in the database.
// The environment wins when it sets a key (and the page shows it read-only), else the stored value applies, else
// the schema default. Only the sysop (or the operator secret) reaches the page; every change is checked against
// the schema, rate-limited and written to the audit log, and takes effect at once.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";
import { loadSiteSettings, setting } from "@aprscaching/gateway/siteconfig";
import { retentionFrom, moderationKeepDays } from "@aprscaching/gateway/retention";
import { importBlocked } from "@aprscaching/gateway/import";
import { updateCheckOn } from "@aprscaching/gateway/updatecheck";
import { supportLinks } from "@aprscaching/gateway/support";

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;

interface World {
  env: Env;
  sysop: Res;
}

async function world(extra: Record<string, unknown> = {}, db?: unknown): Promise<World> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", ...extra }, db);
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", nextIp());
  expect(sysop.status).toBe(200);
  await operatorVerify(env, "OE8APR");
  return { env, sysop };
}

const put = (w: World, key: string, value: unknown) =>
  call(w.env, "PUT", `/api/admin/settings/${key}`, { value }, { cookie: w.sysop.cookie });
const reset = (w: World, key: string) =>
  call(w.env, "DELETE", `/api/admin/settings/${key}`, undefined, { cookie: w.sysop.cookie });
const list = async (w: World) => {
  const r = await call(w.env, "GET", "/api/admin/settings", undefined, { cookie: w.sysop.cookie });
  expect(r.status).toBe(200);
  return r;
};
const one = async (w: World, key: string) =>
  (await list(w)).data.settings.find((s: { key: string }) => s.key === key) as Record<string, unknown>;

/** The same instance with one more key in its environment: the same database, so the stored rows are shared. */
const withEnv = (w: World, extra: Record<string, string>): Env => ({ ...w.env, ...extra }) as Env;

const auditRows = async (env: Env) =>
  (
    await env.DB.prepare(
      "SELECT actor_call, action, target_kind, target_id, reason FROM moderation_log WHERE target_kind='setting' ORDER BY id",
    ).all<Record<string, string>>()
  ).results;

describe("the precedence rule", () => {
  it("takes the default, then the stored value, then the environment's", async () => {
    const w = await world();
    expect(await one(w, "HIDE_DAILY_LIMIT")).toMatchObject({ value: "5", source: "default", default: "5" });

    const r = await put(w, "HIDE_DAILY_LIMIT", " 12 ");
    expect(r.status).toBe(200);
    expect(r.data.setting).toMatchObject({ value: "12", source: "site", stored: { value: "12", by: "OE8APR" } });
    expect(await one(w, "HIDE_DAILY_LIMIT")).toMatchObject({ value: "12", source: "site" });

    const env = withEnv(w, { HIDE_DAILY_LIMIT: "3" });
    const shown = await call(env, "GET", "/api/admin/settings", undefined, { cookie: w.sysop.cookie });
    const row = shown.data.settings.find((s: { key: string }) => s.key === "HIDE_DAILY_LIMIT");
    // the environment wins, and the stored value stays visible as overridden
    expect(row).toMatchObject({ value: "3", source: "env", stored: { value: "12" } });
    expect(setting(env, "HIDE_DAILY_LIMIT")).toBe("3");
    // a blank environment value counts as unset, as compose passes ${VAR:-}
    expect(setting(withEnv(w, { HIDE_DAILY_LIMIT: " " }), "HIDE_DAILY_LIMIT")).toBe("12");

    expect((await reset(w, "HIDE_DAILY_LIMIT")).data.setting).toMatchObject({ value: "5", source: "default" });
  });

  it("refuses a change and a reset of a key the environment sets, with 409", async () => {
    const w = await world({ OPERATOR_NAME: "Club Station OE8XYZ" });
    const p = await put(w, "OPERATOR_NAME", "Someone else");
    expect(p.status).toBe(409);
    expect(p.data.error).toMatch(/set by the environment/);
    expect((await reset(w, "OPERATOR_NAME")).status).toBe(409);
    expect(await one(w, "OPERATOR_NAME")).toMatchObject({ value: "Club Station OE8XYZ", source: "env" });
    expect(await auditRows(w.env)).toEqual([]);
  });

  it("describes every setting: group, label, hint, type and bounds", async () => {
    const w = await world();
    const r = await list(w);
    expect(r.data.groups.map((g: { id: string }) => g.id)).toEqual([
      "game",
      "accounts",
      "retention",
      "imports",
      "federation",
      "imprint",
      "support",
      "updates",
    ]);
    const keys = r.data.settings.map((s: { key: string }) => s.key);
    for (const secretOrAddress of ["INGEST_SECRET", "SESSION_SECRET", "APP_URL", "RP_ID", "ADMIN_CALLSIGNS"])
      expect(keys).not.toContain(secretOrAddress);
    expect(await one(w, "CACHE_MOVE_LIMIT_M")).toMatchObject({
      group: "game",
      type: "number",
      min: 0,
      unit: "m",
      label: expect.any(String),
      hint: expect.any(String),
    });
    expect(await one(w, "UPDATE_CHECK")).toMatchObject({ control: "switch" });
    expect(await one(w, "IMPORT_ALLOW")).toMatchObject({ options: ["wwff", "gcau", "iota"] });
    expect((await one(w, "RETENTION")).fields).toContainEqual(
      expect.objectContaining({ id: "packetsHours", default: 24, unit: "hours" }),
    );
  });
});

describe("validation", () => {
  it("refuses a value outside the schema with 400 and stores nothing", async () => {
    const w = await world();
    const bad: [string, unknown][] = [
      ["HIDE_DAILY_LIMIT", "-1"],
      ["HIDE_DAILY_LIMIT", "2.5"],
      ["HIDE_DAILY_LIMIT", "lots"],
      ["HIDE_DAILY_LIMIT", ""],
      ["HIDE_DAILY_LIMIT", 7],
      ["MIN_TRUST", "C"],
      ["IMPORT_ALLOW", "wwff,osm"],
      ["OPERATOR_EMAIL", "not-an-address"],
      ["OPERATOR_NAME", "two\nlines"],
      ["SECURITY_CONTACT", "http://plain.example.net"],
      ["SUPPORT_LINKS", '[{"label":"x","url":"javascript:alert(1)"}]'],
      ["SUPPORT_LINKS", '{"label":"x"}'],
      ["RETENTION", '{"packetsHours":0}'],
      ["RETENTION", '{"positionsDays":3}'],
      ["SPOTS_TTL_SEC", "5"],
    ];
    for (const [k, v] of bad) {
      const r = await put(w, k, v);
      expect(r.status, `${k}=${String(v)}`).toBe(400);
      expect(r.data.error, k).toEqual(expect.any(String));
    }
    expect((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM site_settings").first<{ n: number }>())!.n).toBe(0);
  });

  it("stores a value in its normal form", async () => {
    const w = await world();
    expect((await put(w, "IMPORT_ALLOW", "IOTA, wwff,iota")).data.setting.value).toBe("wwff,iota");
    expect((await put(w, "SECURITY_CONTACT", "sec@example.net, https://example.net/sec")).data.setting.value).toBe(
      "mailto:sec@example.net,https://example.net/sec",
    );
    expect(
      (await put(w, "SUPPORT_LINKS", ' [ {"label":" Liberapay ","url":"https://liberapay.com/x"} ] ')).data.setting
        .value,
    ).toBe('[{"label":"Liberapay","url":"https://liberapay.com/x"}]');
  });

  it("answers 404 for a key that is not an instance setting, secrets included", async () => {
    const w = await world();
    expect((await put(w, "INGEST_SECRET", "x".repeat(32))).status).toBe(404);
    expect((await put(w, "APP_URL", "https://evil.example")).status).toBe(404);
    expect((await put(w, "NOPE", "1")).status).toBe(404);
  });
});

describe("who may change a setting", () => {
  it("is the sysop or the operator secret, never a member or a visitor", async () => {
    const w = await world();
    const member = await emailSignup(w.env, "m@example.test", "DL1ABC", nextIp());
    expect((await call(w.env, "GET", "/api/admin/settings")).status).toBe(403);
    expect((await call(w.env, "GET", "/api/admin/settings", undefined, { cookie: member.cookie })).status).toBe(403);
    expect(
      (await call(w.env, "PUT", "/api/admin/settings/HIDE_DAILY_LIMIT", { value: "9" }, { cookie: member.cookie }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          w.env,
          "PUT",
          "/api/admin/settings/HIDE_DAILY_LIMIT",
          { value: "9" },
          { "x-ingest-secret": "test-ingest-secret" },
        )
      ).status,
    ).toBe(403);
    const op = { "x-operator-secret": "test-operator-secret" };
    expect((await call(w.env, "GET", "/api/admin/settings", undefined, op)).status).toBe(200);
    expect((await call(w.env, "PUT", "/api/admin/settings/HIDE_DAILY_LIMIT", { value: "9" }, op)).status).toBe(200);
    expect((await auditRows(w.env)).at(-1)).toMatchObject({ actor_call: "OPERATOR", action: "set" });
  });
});

describe("the audit log", () => {
  it("records each change and reset with the old and the new value", async () => {
    const w = await world();
    await put(w, "HIDE_DAILY_LIMIT", "10");
    await put(w, "HIDE_DAILY_LIMIT", "10"); // unchanged: no row
    await put(w, "HIDE_DAILY_LIMIT", "20");
    await reset(w, "HIDE_DAILY_LIMIT");
    await reset(w, "HIDE_DAILY_LIMIT"); // already the default: no row
    expect(await auditRows(w.env)).toEqual([
      {
        actor_call: "OE8APR",
        action: "set",
        target_kind: "setting",
        target_id: "HIDE_DAILY_LIMIT",
        reason: "default (5) → 10",
      },
      { actor_call: "OE8APR", action: "set", target_kind: "setting", target_id: "HIDE_DAILY_LIMIT", reason: "10 → 20" },
      {
        actor_call: "OE8APR",
        action: "reset",
        target_kind: "setting",
        target_id: "HIDE_DAILY_LIMIT",
        reason: "20 → default",
      },
    ]);
    const log = await call(w.env, "GET", "/api/admin/moderation/log", undefined, { cookie: w.sysop.cookie });
    expect(log.data.entries[0]).toMatchObject({ action: "reset", kind: "setting", targetId: "HIDE_DAILY_LIMIT" });
  });
});

describe("a change takes effect at once", () => {
  it("on the next request, through the same process's cache", async () => {
    const w = await world();
    const me = await emailSignup(w.env, "k@example.test", "DL1KEY", nextIp());
    const cap = async (env: Env) => (await call(env, "GET", "/api/keys", undefined, { cookie: me.cookie })).data.cap;
    expect(await cap(w.env)).toBe(5);
    await put(w, "API_KEYS_PER_ACCOUNT", "0");
    expect(await cap(w.env)).toBe(0);
    expect((await call(w.env, "POST", "/api/keys", { name: "x" }, { cookie: me.cookie })).status).not.toBe(201);
    await reset(w, "API_KEYS_PER_ACCOUNT");
    expect(await cap(w.env)).toBe(5);
  });

  it("in another process on the same database once its cache is read again", async () => {
    const w = await world();
    const other = authEnv({ ADMIN_CALLSIGNS: "OE8APR" }, w.env.DB);
    await loadSiteSettings(other);
    expect(setting(other, "HIDE_DAILY_LIMIT")).toBe("5");
    await put(w, "HIDE_DAILY_LIMIT", "8");
    await loadSiteSettings(other, true);
    expect(setting(other, "HIDE_DAILY_LIMIT")).toBe("8");
  });
});

describe("every converted read still honours the environment", () => {
  it("game rules: the minimum tier", async () => {
    const w = await world();
    const hide = await call(
      w.env,
      "POST",
      "/api/caches",
      { title: "under the oak", type: "traditional", lat: 47.1, lon: 15.4, description: "a box" },
      { cookie: w.sysop.cookie },
    );
    expect(hide.status).toBe(201);
    const id = hide.data.cache.id as number;
    const tier = async (env: Env) => (await call(env, "GET", `/api/caches/${id}`)).data.cache.minTrust;
    expect(await tier(w.env)).toBe("B");
    await put(w, "MIN_TRUST", "A");
    expect(await tier(w.env)).toBe("A");
    expect(await tier(withEnv(w, { MIN_TRUST: "B" }))).toBe("B");
  });

  it("accounts & API: the key cap and the rate limits", async () => {
    const w = await world();
    await put(w, "API_KEYS_PER_ACCOUNT", "1");
    await put(w, "API_RATE_ANON", "1");
    const ip = "203.0.113.77";
    expect((await call(w.env, "GET", "/api/v1/activity", undefined, {}, ip)).status).toBe(200);
    expect((await call(w.env, "GET", "/api/v1/activity", undefined, {}, ip)).status).toBe(429);
    const env = withEnv(w, { API_RATE_ANON: "100", API_KEYS_PER_ACCOUNT: "4" });
    expect((await call(env, "GET", "/api/v1/activity", undefined, {}, "203.0.113.78")).status).toBe(200);
    expect((await call(env, "GET", "/api/v1/activity", undefined, {}, "203.0.113.78")).status).toBe(200);
    const me = await emailSignup(w.env, "c@example.test", "DL1CAP", nextIp());
    expect((await call(env, "GET", "/api/keys", undefined, { cookie: me.cookie })).data.cap).toBe(4);
  });

  it("privacy & retention: the retention periods", async () => {
    const w = await world();
    await put(w, "RETENTION", '{"packetsHours":6}');
    await put(w, "MODERATION_RETENTION_DAYS", "90");
    await put(w, "MESHCOM_NODE_TTL_DAYS", "3");
    expect(retentionFrom(w.env).packetsHours).toBe(6);
    expect(moderationKeepDays(w.env)).toBe(90);
    expect(setting(w.env, "MESHCOM_NODE_TTL_DAYS")).toBe("3");
    const env = withEnv(w, { RETENTION: '{"packetsHours":2}', MODERATION_RETENTION_DAYS: "30" });
    expect(retentionFrom(env).packetsHours).toBe(2);
    expect(moderationKeepDays(env)).toBe(30);
  });

  it("imports & data sources: permitted imports and spots", async () => {
    const w = await world();
    expect(importBlocked(w.env, "wwff")).toMatch(/IMPORT_ALLOW/);
    await put(w, "IMPORT_ALLOW", "wwff");
    expect(importBlocked(w.env, "wwff")).toBeNull();
    expect(importBlocked(withEnv(w, { IMPORT_ALLOW: "iota" }), "wwff")).toMatch(/IMPORT_ALLOW/);
    await put(w, "SPOTS_ENABLED", "1");
    expect(setting(w.env, "SPOTS_ENABLED")).toBe("1");
    expect(setting(withEnv(w, { SPOTS_ENABLED: "0" }), "SPOTS_ENABLED")).toBe("0");
  });

  it("imprint & contact: the legal pages and security.txt", async () => {
    const w = await world();
    const page = async (env: Env, path: string) => (await serve(env)(new Request(`https://gw.test${path}`))).text();
    expect(await page(w.env, "/imprint")).toContain("not configured");
    await put(w, "OPERATOR_NAME", "Max Mustermann");
    await put(w, "OPERATOR_ADDRESS", "Musterweg 1, 8010 Graz");
    await put(w, "OPERATOR_EMAIL", "op@example.net");
    const html = await page(w.env, "/imprint");
    expect(html).toContain("Max Mustermann");
    expect(html).not.toContain("not configured");
    expect(await page(w.env, "/.well-known/security.txt")).toContain("Contact: mailto:op@example.net");
    expect(await page(withEnv(w, { OPERATOR_NAME: "Club OE8XYZ" }), "/imprint")).toContain("Club OE8XYZ");
  });

  it("support links", async () => {
    const w = await world();
    await put(w, "SUPPORT_LINKS", '[{"label":"Liberapay","url":"https://liberapay.com/x"}]');
    expect(supportLinks(w.env)).toEqual([{ label: "Liberapay", url: "https://liberapay.com/x" }]);
    expect(supportLinks(withEnv(w, { SUPPORT_LINKS: "[]" }))).toEqual([]);
  });

  it("updates: the daily release check", async () => {
    const w = await world({ UPDATE_CHECK: "" });
    expect(updateCheckOn(w.env)).toBe(true);
    await put(w, "UPDATE_CHECK", "0");
    expect(updateCheckOn(w.env)).toBe(false);
    expect(updateCheckOn(withEnv(w, { UPDATE_CHECK: "1" }))).toBe(true);
  });
});

describe("rate limit", () => {
  it("refuses a burst of changes with 429", async () => {
    const w = await world();
    let last = 0;
    for (let i = 0; i < 125 && last !== 429; i++) last = (await put(w, "HIDE_DAILY_LIMIT", String(i % 50))).status;
    expect(last).toBe(429);
  });
});
