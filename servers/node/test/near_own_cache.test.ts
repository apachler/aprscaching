// SPDX-License-Identifier: AGPL-3.0-or-later
// A beacon near a cache raises the "you're near" prompt for its station, except near a cache the station's own
// operator hid or already logged (found or did-not-find): under the station's base call, an SSID of it, or another
// call of the same account.
import { describe, it, expect } from "vitest";
import { authEnv } from "./helpers/authflow.js";
import { envelopeForPosition } from "@aprscaching/gateway/live";
import type { Env } from "@aprscaching/gateway/env";

async function world() {
  const env = authEnv() as Env;
  const add = async (code: string, owner: string, lat: number) =>
    Number(
      (
        await env.DB.prepare(
          "INSERT INTO caches (code, owner_call, title, type, lat, lon, status, created_at, updated_at) VALUES (?, ?, ?, 'traditional', ?, 15.42, 'active', 1, 1)",
        )
          .bind(code, owner, code, lat)
          .run()
      ).meta.last_row_id,
    );
  return { env, add };
}
const prompted = async (env: Env, call: string) =>
  ((await envelopeForPosition(env, call, 47.07, 15.42)).prompts ?? []).map((p) => p.prompt.code).sort();

describe("the near prompt", () => {
  it("skips the caches the station's operator hid, by base call and SSID", async () => {
    const { env, add } = await world();
    await add("AC-MINE", "OE8NER", 47.0701);
    await add("AC-SSID", "OE8NER-7", 47.0702);
    await add("AC-THEIRS", "OE1XYZ", 47.0703);
    expect(await prompted(env, "OE8NER-9")).toEqual(["AC-THEIRS"]);
    expect(await prompted(env, "OE1ABC")).toEqual(["AC-MINE", "AC-SSID", "AC-THEIRS"]);
  });

  it("skips a cache hidden under another call of the same account", async () => {
    const { env, add } = await world();
    for (const call of ["OE8NER", "OE8ZZZ"])
      await env.DB.prepare("INSERT INTO account_callsigns (account_id, callsign, added_at) VALUES ('acct-near', ?, 1)")
        .bind(call)
        .run();
    await add("AC-OTHER", "OE8ZZZ-5", 47.0701);
    expect(await prompted(env, "OE8NER-7")).toEqual([]);
  });

  it("skips a cache the station's operator found or logged as a did-not-find, under any SSID", async () => {
    const { env, add } = await world();
    const found = await add("AC-FOUND", "OE1XYZ", 47.0701);
    const dnf = await add("AC-DNF", "OE1XYZ", 47.0702);
    await add("AC-OPEN", "OE1XYZ", 47.0703);
    for (const [id, type] of [
      [found, "found"],
      [dnf, "dnf"],
    ] as const)
      await env.DB.prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, received_at) VALUES (?, 'OE8NER-7', 1, ?, 0, 1)",
      )
        .bind(id, type)
        .run();
    expect(await prompted(env, "OE8NER-9")).toEqual(["AC-OPEN"]);
    expect(await prompted(env, "OE1ABC")).toEqual(["AC-DNF", "AC-FOUND", "AC-OPEN"]);
  });
});
