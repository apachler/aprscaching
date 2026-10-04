// SPDX-License-Identifier: AGPL-3.0-or-later
// A find announced on APRS-IS is one status line, whatever characters the cache title or code holds.
import { describe, it, expect } from "vitest";
import { maybeAnnounceFind } from "../src/announce.js";
import type { Env } from "../src/env.js";

function announceEnv(rows: unknown[][], extra: Record<string, string> = { APP_URL: "https://oe.example.net/" }): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => (sql.includes("announce_is") ? { announce_is: 1, announce_tocall: "APZACG" } : null),
            all: async () =>
              sql.includes("callsign_verifications")
                ? { results: args.map((c) => ({ callsign: c, method: "operator" })) }
                : { results: [] },
            run: async () => {
              if (sql.startsWith("INSERT INTO aprs_outbox")) rows.push(args);
              return { meta: {} };
            },
          };
        },
      };
    },
  };
  return { DB: db, ...extra } as unknown as Env;
}

describe("find announce", () => {
  it("queues a status naming the cache", async () => {
    const rows: unknown[][] = [];
    expect(await maybeAnnounceFind(announceEnv(rows), "OE8APR-7", "AC-1234", "Old mill")).toBe(true);
    expect(rows[0]![3]).toBe(">Found AC-1234 (Old mill) via oe.example.net");
  });

  it("names the instance by its own host", async () => {
    const rows: unknown[][] = [];
    await maybeAnnounceFind(announceEnv(rows, { INSTANCE: "Shack.Example.org" }), "OE8APR-7", "AC-1");
    await maybeAnnounceFind(announceEnv(rows, { INSTANCE: "local" }), "OE8APR-7", "AC-2");
    await maybeAnnounceFind(announceEnv(rows, {}), "OE8APR-7", "AC-3");
    expect(rows.map((r) => r[3])).toEqual([
      ">Found AC-1 via shack.example.org",
      ">Found AC-2 via APRScaching",
      ">Found AC-3 via APRScaching",
    ]);
  });

  it("drops control characters from the title and code", async () => {
    const rows: unknown[][] = [];
    await maybeAnnounceFind(announceEnv(rows), "OE8APR-7", "AC-1\r234", "Old\r\nOE1ABC>APRS:x\0 mill");
    expect(rows[0]![3]).toBe(">Found AC-1234 (OldOE1ABC>APRS:x mill) via oe.example.net");
    const blank: unknown[][] = [];
    await maybeAnnounceFind(announceEnv(blank), "OE8APR-7", "AC-1234", "\r\n");
    expect(blank[0]![3]).toBe(">Found AC-1234 via oe.example.net");
  });
});
