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

/** The signed-in operator's identity rows: the account holds its call. */
function operatorRow(sql: string): Record<string, unknown> | null {
  if (sql.includes("SELECT session_gen FROM accounts")) return { session_gen: 0 };
  if (sql.includes("FROM account_callsigns")) return { account_id: "acct-op" };
  if (sql.startsWith("SELECT account_id FROM accounts")) return { account_id: "acct-op" };
  return null;
}
/** The verification store: the operator's call is control-verified. */
const verifiedRows = (sql: string) =>
  sql.includes("FROM callsign_verifications") ? [{ callsign: "OE8APR", method: "operator", verified_at: 1 }] : [];

/** Mock DB answering the checklist's COUNT probes (keyed on table name), the session lookups and the trusted rows. */
const db = (counts: Record<string, number>, trusted: { site: string; box: string | null }[] = []) => ({
  prepare(sql: string) {
    return {
      async all() {
        return { results: sql.includes("FROM trusted_sites") ? trusted : [] };
      },
      bind() {
        return {
          async first() {
            const who = operatorRow(sql);
            if (who) return who;
            for (const [table, n] of Object.entries(counts)) if (sql.includes(table)) return { n };
            return { n: 0 };
          },
          async run() {
            return { meta: {} };
          },
          async all() {
            return { results: verifiedRows(sql) };
          },
        };
      },
    };
  },
});

const baseEnv = (over: Partial<Env> = {}, counts: Record<string, number> = {}): Env =>
  ({
    INGEST_SECRET: SECRET,
    SESSION_SECRET: "a-strong-session-secret-456",
    ADMIN_CALLSIGNS: "OE8APR",
    DB: db(counts),
    ...over,
  }) as unknown as Env;

const get = async (env: Env, callsign: string | null) => {
  const headers: Record<string, string> = {};
  if (callsign) headers.cookie = (await issueSessionCookie(env, "acct-op", callsign)).split(";")[0]!;
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

  it("200 for the operator secret, so the operator's scripts can read it", async () => {
    const env = baseEnv({ OPERATOR_SECRET: "operator-secret-value-321" });
    const req = (secret: string) =>
      handleAdminSetup(new Request("http://gw/api/admin/setup", { headers: { "x-operator-secret": secret } }), env);
    expect((await req("operator-secret-value-321")).status).toBe(200);
    expect((await req("wrong-operator-secret")).status).not.toBe(200);
    expect((await req(SECRET)).status).not.toBe(200); // the ingest secret never reaches it
  });
});

describe("GET /api/admin/setup — env items are statuses, never secret values", () => {
  it("never echoes a secret value anywhere in the body", async () => {
    const env = baseEnv({
      SESSION_SECRET: "session-secret-value-789",
      OPERATOR_SECRET: "operator-secret-value-321",
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
      "operator-secret-value-321",
      "fed-key-material-abc",
      "re_email_key_xyz",
      "vapid-priv-material",
    ])
      expect(body).not.toContain(secret);
  });

  it("names the SMTP transport, never its password", async () => {
    const env = baseEnv({
      EMAIL_FROM: "op@example.net",
      SMTP_HOST: "mail.example.net",
      SMTP_USER: "op@example.net",
      SMTP_PASS: "smtp-password-value-456",
    });
    const body = await (await get(env, "OE8APR")).text();
    expect(body).toContain("SMTP mail.example.net:587 (starttls)");
    expect(body).not.toContain("smtp-password-value-456");
  });

  it("every env item is marked read-only (source: env)", async () => {
    const items = await itemsOf(await get(baseEnv(), "OE8APR"));
    for (const i of items.filter((x) => !x.key.startsWith("db:"))) expect(i.source).toBe("env");
  });

  it("reports missing/warn states for an unconfigured instance", async () => {
    const items = await itemsOf(await get(baseEnv(), "OE8APR"));
    expect(find(items, "INGEST_SECRET").status).toBe("ok"); // strong secret in baseEnv
    expect(find(items, "SESSION_SECRET").status).toBe("ok"); // a signed-in operator implies one
    expect(find(items, "OPERATOR_SECRET").status).toBe("warn"); // operator scripts closed
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

  it("counts the stations trusted in Instance admin and through enrolled boxes, not only FIRST_PARTY_SITES", async () => {
    const env = baseEnv({
      DB: db({}, [
        { site: "oe8xyz-10", box: null },
        { site: "OE8LNT-3", box: "box-1" },
      ]),
    } as unknown as Partial<Env>);
    const item = find(await itemsOf(await get(env, "OE8APR")), "FIRST_PARTY_SITES");
    expect(item.status).toBe("ok");
    expect(item.detail).toContain("2 trusted receiving stations");
    expect(item.detail).toContain("OE8XYZ-10");
    expect(item.detail).toContain("OE8LNT-3");
  });

  it("names Instance admin when no station is trusted", async () => {
    const item = find(await itemsOf(await get(baseEnv(), "OE8APR")), "FIRST_PARTY_SITES");
    expect(item.detail).toContain("Instance admin → Trusted receiving stations");
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

  it("reports the operator's own control-verification state from the verification store", async () => {
    const items = await itemsOf(await get(baseEnv(), "OE8APR"));
    expect(find(items, "db:verify")).toMatchObject({ status: "ok", source: "db" });
  });

  it("a failing probe degrades to a warn, never a 500", async () => {
    const broken = baseEnv({
      DB: {
        prepare(sql: string) {
          // identity, suspension and verification lookups answer; every checklist probe fails
          if (operatorRow(sql) || verifiedRows(sql).length || sql.includes("FROM account_suspensions"))
            return db({}).prepare(sql);
          throw new Error("no such table");
        },
      } as unknown as Env["DB"],
    });
    const res = await get(broken, "OE8APR");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/setup — three levels", () => {
  const blockingOpen = (items: SetupItem[]) => items.filter((i) => i.level === "blocking" && i.status !== "ok");

  it("gives every item a level", async () => {
    const items = await itemsOf(await get(baseEnv(), "OE8APR"));
    for (const i of items) expect(["blocking", "recommended", "optional"]).toContain(i.level);
    expect(find(items, "INGEST_SECRET").level).toBe("blocking");
    expect(find(items, "SESSION_SECRET").level).toBe("blocking");
    expect(find(items, "db:ingest").level).toBe("blocking");
    expect(find(items, "OPERATOR").level).toBe("recommended");
    expect(find(items, "VAPID").level).toBe("optional");
    expect(find(items, "db:peers").level).toBe("optional");
  });

  it("a working https box with only the essentials has nothing blocking", async () => {
    const env = baseEnv(
      { APP_URL: "https://oe.example.net", OPERATOR_SECRET: "a-strong-operator-secret" },
      { packets_recent: 12 },
    );
    const items = await itemsOf(await get(env, "OE8APR"));
    expect(blockingOpen(items)).toEqual([]);
  });

  it("does not flag the passkey domain or instance id when both follow APP_URL", async () => {
    const items = await itemsOf(await get(baseEnv({ APP_URL: "https://oe.example.net" }), "OE8APR"));
    expect(find(items, "RP_ID")).toMatchObject({ status: "ok" });
    expect(find(items, "RP_ID").detail).toContain("oe.example.net");
    expect(find(items, "INSTANCE")).toMatchObject({ status: "ok" });
    expect(find(items, "INSTANCE").detail).toContain("oe.example.net");
  });

  it("marks email blocking only when there is no way to sign in at all", async () => {
    // no https origin, no email, no operator secret: nobody can sign in
    const closed = await itemsOf(await get(baseEnv({ APP_URL: "http://192.168.1.10" }), "OE8APR"));
    expect(find(closed, "EMAIL")).toMatchObject({ level: "blocking", status: "missing" });
    // off-grid with the operator's sign-in link: email is optional
    const offGrid = await itemsOf(
      await get(baseEnv({ APP_URL: "http://192.168.1.10", OPERATOR_SECRET: "a-strong-operator-secret" }), "OE8APR"),
    );
    expect(find(offGrid, "EMAIL").level).toBe("optional");
    expect(find(offGrid, "EMAIL").status).not.toBe("missing");
    // a public https instance: passkeys work, email is recommended for recovery
    const pub = await itemsOf(await get(baseEnv({ APP_URL: "https://oe.example.net" }), "OE8APR"));
    expect(find(pub, "EMAIL")).toMatchObject({ level: "recommended", status: "warn" });
  });
});

describe("GET /api/admin/setup — the 44Net item", () => {
  it("appears only when FED_ENDPOINTS has a 44net endpoint, naming the host and callsign", async () => {
    const none = await itemsOf(await get(baseEnv(), "OE8APR"));
    expect(none.find((i) => i.key === "44net")).toBeUndefined();
    const env = baseEnv({
      FED_ENDPOINTS: '[{"transport":"44net","address":"aprscaching.oe8apr.ampr.org","priority":10}]',
    });
    const item = find(await itemsOf(await get(env, "OE8APR")), "44net");
    expect(item).toMatchObject({ level: "optional", group: "trust", source: "env" });
    expect(item.detail).toContain("aprscaching.oe8apr.ampr.org");
  });
});
