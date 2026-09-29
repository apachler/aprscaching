// SPDX-License-Identifier: AGPL-3.0-or-later
// The baseline schema carries only columns something writes, and an account row always carries its
// durable identity.
import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers/fedpeer.js";

const columns = (sqlite: ReturnType<typeof freshDb>["sqlite"], table: string) =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]).map((c) => c.name);

describe("baseline schema", () => {
  it("requires an account_id on every account row", () => {
    const { sqlite } = freshDb();
    expect(() => sqlite.prepare("INSERT INTO accounts (callsign, created_at) VALUES ('OE8APR', 1)").run()).toThrow(
      /NOT NULL/,
    );
    sqlite.prepare("INSERT INTO accounts (callsign, account_id, created_at) VALUES ('OE8APR', 'acct-1', 1)").run();
  });

  it("has no weather or station columns that nothing writes", () => {
    const { sqlite } = freshDb();
    expect(columns(sqlite, "sensor_readings")).not.toContain("rain_mid_mm");
    expect(columns(sqlite, "sensor_readings")).not.toContain("snow_mm");
    expect(columns(sqlite, "stations")).not.toContain("status_color");
    expect(columns(sqlite, "stations")).not.toContain("ssid");
  });
});
