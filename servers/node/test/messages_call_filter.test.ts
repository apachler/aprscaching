// SPDX-License-Identifier: AGPL-3.0-or-later
// The Messages list narrows to one operator's traffic: sent or received under any SSID of the base call.
import { describe, it, expect } from "vitest";
import { authEnv, call } from "./helpers/authflow.js";

describe("messages for one call", () => {
  it("lists traffic from or to any SSID of the base call, and nothing else", async () => {
    const env = authEnv();
    const rows: [string, string, string][] = [
      ["OE8ABC-7", "OE3XYZ", "from an SSID"],
      ["OE3XYZ", "OE8ABC", "to the base call"],
      ["OE3XYZ", "OE8ABC-9", "to another SSID"],
      ["OE3XYZ", "OE8ABCD", "a longer call that starts the same"],
      ["OE6QRS", "BLN1", "a bulletin"],
    ];
    for (const [i, [from, to, body]] of rows.entries())
      await env.DB.prepare("INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?,?,?,?, 'rx')")
        .bind(1_000 + i, from, to, body)
        .run();

    const mine = (await call(env, "GET", "/api/messages?call=oe8abc-7")).data.messages.map(
      (m: { body: string }) => m.body,
    );
    expect(mine).toEqual(["to another SSID", "to the base call", "from an SSID"]);

    expect((await call(env, "GET", "/api/messages")).data.messages).toHaveLength(5);
    expect((await call(env, "GET", "/api/messages?call=%25")).status).toBe(400);
  });

  it("leaves out the service call's traffic, which shares the sysop's base call", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8ABC" });
    const rows: [string, string, string][] = [
      ["OE8ABC-7", "OE3XYZ", "the sysop's own"],
      ["OE3XYZ", "OE8ABC-15", "a player's command"],
      ["OE8ABC-15", "OE3XYZ", "the instance's answer"],
    ];
    for (const [i, [from, to, body]] of rows.entries())
      await env.DB.prepare("INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?,?,?,?, 'rx')")
        .bind(1_000 + i, from, to, body)
        .run();
    const mine = (await call(env, "GET", "/api/messages?call=OE8ABC")).data.messages.map(
      (m: { body: string }) => m.body,
    );
    expect(mine).toEqual(["the sysop's own"]);
  });
});
