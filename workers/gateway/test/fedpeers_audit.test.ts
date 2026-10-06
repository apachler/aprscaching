// SPDX-License-Identifier: AGPL-3.0-or-later
// Every federation trust decision the sysop takes lands in the audit log: adding, following and removing a
// peer, and moving it between trusted, unvetted and blocked. The handlers run over a real SQLite database
// holding the baseline schema.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { handlePeerAdd, handlePeerRemove, handlePeerTrust } from "../src/fedpeers.js";
import { handlePeerFollow } from "../src/feddiscover.js";
import { keyFingerprint } from "../src/federation.js";
import type { Env } from "../src/env.js";

const BASELINE = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0001_baseline.sql", import.meta.url)),
  "utf8",
);
const SECRET = "sysop-bypass-secret";
const KEY = "A".repeat(43); // a base64url-shaped 32-byte Ed25519 key
const realFetch = globalThis.fetch;

/** The gateway's statement surface over node:sqlite, enough for these handlers. */
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
  return {
    raw: db,
    prepare: (sql: string) => stmt(sql),
    async batch(list: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  };
}

let db: ReturnType<typeof sqlDb>;
let env: Env;
beforeEach(() => {
  db = sqlDb();
  env = { DB: db, OPERATOR_SECRET: SECRET, INSTANCE: "here.example" } as unknown as Env;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const req = (path: string, method: string, body?: unknown) =>
  new Request(`http://gw${path}`, {
    method,
    headers: { "content-type": "application/json", "x-operator-secret": SECRET },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

/** The audit rows, oldest first. */
const auditRows = () =>
  db.raw
    .prepare("SELECT actor_call, action, target_kind, target_id, target_label, reason FROM moderation_log ORDER BY id")
    .all() as {
    actor_call: string;
    action: string;
    target_kind: string;
    target_id: string;
    target_label: string;
    reason: string | null;
  }[];

const peer = (url: string, instance: string, trust: string, extra = "") =>
  db.raw.exec(
    `INSERT INTO fed_peers (url, instance, public_key, trust, added_via, enabled ${extra ? ", discovered" : ""})
     VALUES ('${url}', '${instance}', '${KEY}', '${trust}', 'admin', 1 ${extra ? `, '${extra}'` : ""})`,
  );

/** A peer's descriptor answering at every address. */
function serveDescriptor(instance: string) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ instance, signed: true, publicKey: KEY, operator: "OE3XYZ" }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("the audit log of federation trust", () => {
  it("records trust, unvet, block and unblock with the move and the sysop's note", async () => {
    peer("https://peer.example", "peer.example", "unvetted");
    const fingerprint = await keyFingerprint(KEY);
    const url = "https://peer.example";
    const steps: [string, Record<string, unknown>][] = [
      ["trusted", { fingerprint }],
      ["unvetted", {}],
      ["blocked", { reason: "relays spam" }],
      ["unvetted", {}],
    ];
    for (const [trust, extra] of steps) {
      const r = await handlePeerTrust(req("/federation/peers/trust", "POST", { url, trust, ...extra }), env);
      expect(r.status).toBe(200);
    }
    expect(auditRows()).toEqual([
      {
        actor_call: "OPERATOR",
        action: "trust",
        target_kind: "peer",
        target_id: "peer.example",
        target_label: "peer.example (https://peer.example)",
        reason: "unvetted → trusted",
      },
      expect.objectContaining({ action: "unvet", reason: "trusted → unvetted" }),
      expect.objectContaining({ action: "block", reason: "unvetted → blocked: relays spam" }),
      expect.objectContaining({ action: "unblock", reason: "blocked → unvetted" }),
    ]);
  });

  it("records nothing when the level does not change, or the change is refused", async () => {
    peer("https://peer.example", "peer.example", "unvetted");
    const same = await handlePeerTrust(
      req("/federation/peers/trust", "POST", { url: "https://peer.example", trust: "unvetted" }),
      env,
    );
    expect(same.status).toBe(200);
    const refused = await handlePeerTrust(
      req("/federation/peers/trust", "POST", { url: "https://peer.example", trust: "trusted" }), // no fingerprint
      env,
    );
    expect(refused.status).toBe(400);
    expect(auditRows()).toEqual([]);
  });

  it("records removing a peer with the level it had", async () => {
    peer("https://peer.example", "peer.example", "trusted");
    const r = await handlePeerRemove(req("/federation/peers?url=https://peer.example", "DELETE"), env);
    expect(r.status).toBe(200);
    expect(auditRows()).toEqual([
      expect.objectContaining({ action: "remove-peer", target_id: "peer.example", reason: "was trusted" }),
    ]);
  });

  it("records adding a peer by its address, not the look-up before it", async () => {
    serveDescriptor("peer.example");
    const fingerprint = await keyFingerprint(KEY);
    const look = await handlePeerAdd(req("/federation/peers", "POST", { url: "https://peer.example" }), env);
    expect(look.status).toBe(200);
    expect(auditRows()).toEqual([]);
    const add = await handlePeerAdd(
      req("/federation/peers", "POST", { url: "https://peer.example", fingerprint }),
      env,
    );
    expect(add.status).toBe(201);
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: "add-peer",
        target_kind: "peer",
        target_id: "peer.example",
        reason: `unvetted, key ${fingerprint}`,
      }),
    ]);
  });

  it("records following a discovered instance, at the address it answered on", async () => {
    peer(
      "discovered:peer.example",
      "peer.example",
      "unvetted",
      JSON.stringify([{ via: "mdns", at: 1, addr: "https://peer.example" }]),
    );
    serveDescriptor("peer.example");
    const r = await handlePeerFollow(req("/federation/peers/follow", "POST", { url: "discovered:peer.example" }), env);
    expect(r.status).toBe(200);
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: "follow",
        target_id: "peer.example",
        target_label: "peer.example (https://peer.example)",
        reason: `unvetted, key ${await keyFingerprint(KEY)}`,
      }),
    ]);
  });
});
