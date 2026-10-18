// SPDX-License-Identifier: AGPL-3.0-or-later
// Web Push subscriptions and sends, and the email digest's bookkeeping, over a real SQLite database holding the
// baseline schema.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/env.js";
import { sessionDb, sessionRequest } from "./sessiondb.js";
import { bytesToB64url } from "../src/util/b64.js";

import { handlePushSubscribe, pushAlert, deliverPushes, runDigests } from "../src/notify.js";

/** The Resend API, stubbed: each mail lands in `sent`, and `deliver` decides the answer. */
const mail = {
  deliver: async (): Promise<boolean> => true,
  sent: [] as { to: string; subject: string; text: string }[],
};
function stubResend() {
  vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
    if (!String(u).startsWith("https://api.resend.com/")) throw new Error(`unexpected fetch ${u}`);
    mail.sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: (await mail.deliver()) ? 200 : 503 });
  });
}

const BASELINE = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0001_baseline.sql", import.meta.url)),
  "utf8",
);
const ACCT = "0b6c1f7e-2f3a-4c55-9a77-1d2e3f405162";
const FCM = "https://fcm.googleapis.com/fcm/send/";

function sqlDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(BASELINE);
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    async run() {
      const r = db.prepare(sql).run(...(params as never[]));
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async all() {
      return { results: db.prepare(sql).all(...(params as never[])), meta: {} };
    },
    async first() {
      return db.prepare(sql).get(...(params as never[])) ?? null;
    },
  });
  return { raw: db, prepare: (sql: string) => stmt(sql) };
}

async function vapid(): Promise<{ VAPID_PUBLIC: string; VAPID_PRIVATE: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { VAPID_PUBLIC: bytesToB64url(raw), VAPID_PRIVATE: jwk.d! };
}

let db: ReturnType<typeof sqlDb>;
let env: Env;
beforeEach(async () => {
  db = sqlDb();
  env = {
    DB: sessionDb({ accountId: ACCT, base: "OE8APR" }, db),
    SESSION_SECRET: "strong-session-secret-xyz",
    APP_URL: "https://aprscaching.example",
    ...(await vapid()),
  } as unknown as Env;
  mail.deliver = async () => true;
  mail.sent = [];
});
afterEach(() => vi.unstubAllGlobals());

const subscribe = async (endpoint: unknown) =>
  handlePushSubscribe(
    await sessionRequest(env, ACCT, "OE8APR", "https://aprscaching.example/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    }),
    env,
  );
const endpoints = () =>
  (db.raw.prepare("SELECT endpoint FROM push_subs ORDER BY id").all() as { endpoint: string }[]).map((r) => r.endpoint);

describe("push subscribe", () => {
  it("refuses an endpoint that is not a public https URL, and stores nothing", async () => {
    for (const bad of [
      "http://127.0.0.1:2019/stop",
      "https://127.0.0.1/x",
      "https://10.0.0.1/x",
      "https://169.254.169.254/latest",
      "https://[::1]/x",
      "https://localhost/x",
      "https://router.local/x",
      "https://8.8.8.8/x",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://user:pw@fcm.googleapis.com/x",
      FCM + "x".repeat(2100),
      "not a url",
      42,
    ]) {
      expect((await subscribe(bad)).status, String(bad)).toBe(400);
    }
    expect(endpoints()).toEqual([]);
  });

  it("stores a push service's endpoint and keeps the newest ten per account", async () => {
    expect((await subscribe(FCM + "a")).status).toBe(201);
    for (let i = 0; i < 11; i++) expect((await subscribe(FCM + i)).status).toBe(201);
    const kept = endpoints();
    expect(kept).toHaveLength(10);
    expect(kept).not.toContain(FCM + "a");
    expect(kept).not.toContain(FCM + "0");
    expect(kept).toContain(FCM + "10");
  });
});

describe("push send", () => {
  const insert = (endpoint: string) =>
    db.raw
      .prepare("INSERT INTO push_subs (account_id, endpoint, topics, created_at) VALUES (?, ?, 'watch', 1)")
      .run(ACCT, endpoint);

  it("never fetches a stored endpoint on a private host, and asks the runtime's guard first", async () => {
    insert("http://127.0.0.1:2019/stop");
    insert("https://10.0.0.1/x");
    insert(FCM + "rebound");
    insert(FCM + "ok");
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      fetched.push(String(u));
      return new Response(null, { status: 201 });
    });
    env.TOOL_FETCH_GUARD = async (u) => {
      if (u.endsWith("rebound")) throw new Error("refused: resolves to a private address");
    };
    await deliverPushes(env, ACCT);
    expect(fetched).toEqual([FCM + "ok"]);
  });

  it("drops a subscription the push service answers 404 or 410 for", async () => {
    insert(FCM + "gone");
    insert(FCM + "missing");
    insert(FCM + "live");
    vi.stubGlobal(
      "fetch",
      async (u: string) => new Response(null, { status: u.endsWith("gone") ? 410 : u.endsWith("missing") ? 404 : 201 }),
    );
    await deliverPushes(env, ACCT);
    expect(endpoints()).toEqual([FCM + "live"]);
  });

  it("does not hold the caller while a push service never answers", async () => {
    insert(FCM + "tarpit");
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", (_u: string, init?: RequestInit) => {
      inits.push(init);
      return new Promise<Response>(() => {});
    });
    const t0 = Date.now();
    const done = await Promise.race([
      pushAlert(env, ACCT).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
    ]);
    expect(done).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(inits[0]?.redirect).toBe("manual");
  });
});

describe("email digest", () => {
  const addAlert = (detail: string, ts: number) =>
    db.raw
      .prepare("INSERT INTO watch_alerts (account_id, callsign, kind, detail, ts) VALUES (?, 'OE8APR', 'heard', ?, ?)")
      .run(ACCT, detail, ts);
  const unnotified = () =>
    (db.raw.prepare("SELECT COUNT(*) AS n FROM watch_alerts WHERE notified = 0").get() as { n: number }).n;
  beforeEach(() => {
    db.raw
      .prepare(
        "INSERT INTO accounts (callsign, account_id, email, notify_digest, created_at) VALUES ('OE8APR', ?, 'a@example.org', 1, 1)",
      )
      .run(ACCT);
    env.EMAIL_FROM = "APRScaching <noreply@aprscaching.example>";
    env.EMAIL_API_KEY = "re_test";
    stubResend();
  });

  it("leaves the alerts waiting when the mail transport fails, and mails them on the next run", async () => {
    addAlert("one", 1);
    addAlert("two", 2);
    mail.deliver = async () => false;
    await runDigests(env);
    expect(mail.sent).toHaveLength(1);
    expect(unnotified()).toBe(2);
    mail.deliver = async () => true;
    await runDigests(env);
    expect(mail.sent).toHaveLength(2);
    expect(unnotified()).toBe(0);
  });

  it("counts every waiting alert in the mail, lists the latest 50, and marks them", async () => {
    for (let i = 0; i < 120; i++) addAlert(`alert ${i}`, i);
    await runDigests(env);
    expect(mail.sent).toHaveLength(1);
    const { text } = mail.sent[0]!;
    expect(text).toContain("120 new alerts");
    expect(text).toContain("alert 119");
    expect(text).not.toContain("alert 69\n");
    expect(text.match(/^• /gm)).toHaveLength(50);
    expect(unnotified()).toBe(0);
  });

  it("keeps an alert raised while the mail is on its way for the next digest", async () => {
    addAlert("before", 1);
    mail.deliver = async () => {
      addAlert("during", 2);
      return true;
    };
    await runDigests(env);
    expect(mail.sent[0]!.text).not.toContain("during");
    expect(
      (db.raw.prepare("SELECT detail FROM watch_alerts WHERE notified = 0").all() as { detail: string }[]).map(
        (r) => r.detail,
      ),
    ).toEqual(["during"]);
  });

  it("marks the alerts when the instance has no mail transport, so no backlog builds", async () => {
    env.EMAIL_FROM = undefined;
    addAlert("one", 1);
    await runDigests(env);
    expect(unnotified()).toBe(0);
  });
});
