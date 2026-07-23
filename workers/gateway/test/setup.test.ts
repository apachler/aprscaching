// SPDX-License-Identifier: AGPL-3.0-or-later
// The sysop Setup checklist: sysop-gated, env-only settings reported read-only as statuses (never
// values), runtime state probed from the DB. The hard invariant under test: no secret value ever
// appears in the response body.
import { describe, it, expect } from "vitest";
import { handleAdminSetup } from "../src/setup.js";
import type { SetupItem } from "../src/setup.js";
import { issueSessionCookie } from "../src/auth.js";
import type { Env } from "../src/env.js";

const SECRET = "a-strong-ingest-secret-123";

/** Mock DB answering the checklist's COUNT probes (keyed on table name) + the session lookups. */
const db = (counts: Record<string, number>) => ({
  prepare(sql: string) {
    return {
      bind() {
        return {
          async first() {
            for (const [table, n] of Object.entries(counts)) if (sql.includes(table)) return { n };
            return { n: 0 };
          },
          async run() {
            return { meta: {} };
          },
        };
      },
    };
  },
});

const baseEnv = (over: Partial<Env> = {}, counts: Record<string, number> = {}): Env =>
  ({
    INGEST_SECRET: SECRET,
    ADMIN_CALLSIGNS: "OE8APR",
    DB: db(counts),
    ...over,
  }) as unknown as Env;

const get = async (env: Env, callsign: string | null) => {
  const headers: Record<string, string> = {};
  if (callsign) headers.cookie = (await issueSessionCookie(callsign, env)).split(";")[0]!;
  return handleAdminSetup(new Request("http://gw/api/admin/setup", { headers }), env);
};

const itemsOf = async (res: Response) => ((await res.json()) as { items: SetupItem[] }).items;
const find = (items: SetupItem[], key: string) => items.find((i) => i.key === key)!;

describe("GET /api/admin/setup — sysop gate", () => {
  it("403 when signed out", async () => {
    expect((await get(baseEnv(), null)).status).toBe(403);
  });

  it("403 for a signed-in non-operator", async () => {
    expect((await get(baseEnv(), "DL1ABC")).status).toBe(403);
  });

  it("200 for the operator", async () => {
    expect((await get(baseEnv(), "OE8APR")).status).toBe(200);
  });
});

describe("GET /api/admin/setup — env items are statuses, never secret values", () => {
  it("never echoes a secret value anywhere in the body", async () => {
    const env = baseEnv({
      SESSION_SECRET: "session-secret-value-789",
      FED_PRIVATE_KEY: "fed-key-material-abc",
      EMAIL_API_KEY: "re_email_key_xyz",
      EMAIL_FROM: "op@example.net",
      VAPID_PUBLIC: "vapid-pub",
      VAPID_PRIVATE: "vapid-priv-material",
    });
    const body = await (await get(env, "OE8APR")).text();
    for (const secret of [
      SECRET,
      "session-secret-value-789",
      "fed-key-material-abc",
      "re_email_key_xyz",
      "vapid-priv-material",
    ])
      expect(body).not.toContain(secret);
  });

  it("every env item is marked read-only (source: env)", async () => {
    const items = await itemsOf(await get(baseEnv(), "OE8APR"));
    for (const i of items.filter((x) => !x.key.startsWith("db:"))) expect(i.source).toBe("env");
  });

  it("reports missing/warn states for an unconfigured instance", async () => {
    const items = await itemsOf(await get(baseEnv(), "OE8APR"));
    expect(find(items, "INGEST_SECRET").status).toBe("ok"); // strong secret in baseEnv
    expect(find(items, "SESSION_SECRET").status).toBe("warn"); // derived from INGEST_SECRET
    expect(find(items, "OPERATOR").status).toBe("missing"); // legal pages unconfigured
    expect(find(items, "FIRST_PARTY_SITES").status).toBe("warn"); // no Tier-A attestation
    expect(find(items, "FED_PRIVATE_KEY").status).toBe("warn"); // unsigned feeds
  });

  it("reports ok + echoes only public identity strings when configured", async () => {
    const env = baseEnv({
      SESSION_SECRET: "dedicated-strong-session-secret",
      INSTANCE: "oe.example.net",
      FIRST_PARTY_SITES: "OE8XBM-10",
      OPERATOR_NAME: "Max Mustermann",
      OPERATOR_ADDRESS: "Musterweg 1",
      OPERATOR_EMAIL: "op@example.net",
    });
    const items = await itemsOf(await get(env, "OE8APR"));
    expect(find(items, "SESSION_SECRET")).toMatchObject({ status: "ok" });
    expect(find(items, "INSTANCE")).toMatchObject({ status: "ok", detail: "oe.example.net" });
    expect(find(items, "FIRST_PARTY_SITES").status).toBe("ok");
    expect(find(items, "FIRST_PARTY_SITES").detail).toContain("OE8XBM-10");
    expect(find(items, "OPERATOR").status).toBe("ok");
  });
});

describe("GET /api/admin/setup — DB probes", () => {
  it("warns on a silent ingest and no caches; ok when fed", async () => {
    const quiet = await itemsOf(await get(baseEnv({}, {}), "OE8APR"));
    expect(find(quiet, "db:ingest").status).toBe("warn");
    expect(find(quiet, "db:caches").status).toBe("warn");

    const fed = await itemsOf(await get(baseEnv({}, { packets_recent: 42, caches: 3, fed_peers: 2 }), "OE8APR"));
    expect(find(fed, "db:ingest")).toMatchObject({ status: "ok", source: "db" });
    expect(find(fed, "db:caches").status).toBe("ok");
    expect(find(fed, "db:peers").detail).toContain("2");
  });

  it("reports the operator's own control-verification state", async () => {
    const unverified = await itemsOf(await get(baseEnv(), "OE8APR"));
    expect(find(unverified, "db:verify").status).toBe("warn");

    const verified = await itemsOf(await get(baseEnv({}, { accounts: 1 }), "OE8APR"));
    expect(find(verified, "db:verify").status).toBe("ok");
  });

  it("a failing probe degrades to a warn, never a 500", async () => {
    const broken = baseEnv({
      DB: {
        prepare() {
          throw new Error("no such table");
        },
      } as unknown as Env["DB"],
    });
    const res = await get(broken, "OE8APR");
    expect(res.status).toBe(200);
  });
});
