// SPDX-License-Identifier: AGPL-3.0-or-later
// A find announced on APRS-IS is one status line, whatever characters the cache title or code holds.
import { describe, it, expect } from "vitest";
import { maybeAnnounceFind } from "../src/announce.js";
import type { Env } from "../src/env.js";

function announceEnv(rows: unknown[][]): Env {
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
  return { DB: db } as unknown as Env;
}

describe("find announce", () => {
  it("queues a status naming the cache", async () => {
    const rows: unknown[][] = [];
    expect(await maybeAnnounceFind(announceEnv(rows), "OE8APR-7", "AC-1234", "Old mill")).toBe(true);
    expect(rows[0]![3]).toBe(">Found AC-1234 (Old mill) via aprscaching.net");
  });

  it("drops control characters from the title and code", async () => {
    const rows: unknown[][] = [];
    await maybeAnnounceFind(announceEnv(rows), "OE8APR-7", "AC-1\r234", "Old\r\nOE1ABC>APRS:x\0 mill");
    expect(rows[0]![3]).toBe(">Found AC-1234 (OldOE1ABC>APRS:x mill) via aprscaching.net");
    const blank: unknown[][] = [];
    await maybeAnnounceFind(announceEnv(blank), "OE8APR-7", "AC-1234", "\r\n");
    expect(blank[0]![3]).toBe(">Found AC-1234 via aprscaching.net");
  });
});
