// SPDX-License-Identifier: AGPL-3.0-or-later
// The outbox the ingest box drains: every row it serves is one APRS-IS line, so a row with a line break or
// NUL in a field is marked failed instead of served.
import { describe, it, expect } from "vitest";
import { outboxPending, outboxRowOk } from "../src/outbox.js";
import type { Env } from "../src/env.js";

const row = (id: number, over: Record<string, string> = {}) => ({
  id,
  src_call: "OE8APR-7",
  tocall: "APZACG",
  kind: "status",
  payload: ">on the air",
  target: "is",
  ...over,
});

describe("outbox rows", () => {
  it("accepts a plain row and refuses CR, LF or NUL in any field", () => {
    expect(outboxRowOk(row(1))).toBe(true);
    for (const [field, v] of [
      ["src_call", "OE8APR\r"],
      ["tocall", "APZACG\nX"],
      ["payload", ">a\r\nOE1ABC>APRS:b"],
      ["payload", ">a\0b"],
    ] as const)
      expect(outboxRowOk(row(1, { [field]: v })), `${field}=${JSON.stringify(v)}`).toBe(false);
  });

  it("serves the plain rows and marks the others failed", async () => {
    const failed: unknown[] = [];
    const rows = [row(1), row(2, { payload: ">a\nb" }), row(3), row(4, { src_call: "X\0" })];
    const db = {
      prepare(sql: string) {
        const all = async () => ({ results: sql.startsWith("SELECT") ? rows : [] });
        return { all, bind: (...args: unknown[]) => ({ sql, args, all, first: async () => null }) };
      },
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        for (const s of stmts) if (s.sql.includes("status='failed'")) failed.push(s.args[0]);
        return [];
      },
    };
    const env = { INGEST_SECRET: "s3cret", DB: db } as unknown as Env;
    const res = await outboxPending(new Request("http://gw/outbox", { headers: { "x-ingest-secret": "s3cret" } }), env);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { id: number }[] };
    expect(items.map((i) => i.id)).toEqual([1, 3]);
    expect(failed).toEqual([2, 4]);
  });

  it("deletes instead of serving a suspended call's rows and the Mailbox messages the service call carries for it", async () => {
    const deleted: unknown[] = [];
    const rows = [
      row(1),
      row(2, { src_call: "OE1BAD-9" }),
      row(3, { src_call: "APRSCG", kind: "message", payload: ":OE5XYZ-9 :de OE1BAD-7: hello{1" }),
      row(4, { src_call: "APRSCG", kind: "message", payload: ":OE5XYZ-9 :de OE1ABC: hello{2" }),
    ];
    const db = {
      prepare(sql: string) {
        const all = async () => ({ results: sql.startsWith("SELECT id, src_call") ? rows : [] });
        const first = async (args: unknown[]) =>
          sql.includes("FROM callsign_suspensions") && args[0] === "OE1BAD"
            ? { category: "spam", until: null, at: 1 }
            : null;
        return { all, bind: (...args: unknown[]) => ({ sql, args, all, first: () => first(args) }) };
      },
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        for (const s of stmts) if (s.sql.startsWith("DELETE FROM aprs_outbox")) deleted.push(s.args[0]);
        return [];
      },
    };
    const env = { INGEST_SECRET: "s3cret", DB: db } as unknown as Env;
    const res = await outboxPending(new Request("http://gw/outbox", { headers: { "x-ingest-secret": "s3cret" } }), env);
    const { items } = (await res.json()) as { items: { id: number }[] };
    expect(items.map((i) => i.id)).toEqual([1, 4]);
    expect(deleted).toEqual([2, 3]);
  });
});
