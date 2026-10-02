// SPDX-License-Identifier: AGPL-3.0-or-later
// A message the operator's browser radio sent is recorded as sent, only from a verified call on their account.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";

describe("sent messages", () => {
  it("are listed as sent, from the operator's own verified call only", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8MSG" });
    const me = await emailSignup(env, "msg@example.test", "OE8MSG");
    const send = (body: Record<string, unknown>, cookie = me.cookie) =>
      call(env, "POST", "/api/messages/sent", body, { cookie });
    const msg = { from: "OE8MSG-7", to: "OE3ABC", text: "QSL?", msgNo: "12" };

    expect((await call(env, "POST", "/api/messages/sent", msg)).status).toBe(401);
    expect((await send(msg)).status).toBe(403); // not verified yet
    await operatorVerify(env, "OE8MSG");
    expect((await send({ ...msg, from: "DL1XYZ" })).status).toBe(403);
    expect((await send({ ...msg, text: "" })).status).toBe(400);
    expect((await send(msg)).status).toBe(200);

    const list = (await call(env, "GET", "/api/messages")).data.messages;
    expect(list).toEqual([
      expect.objectContaining({ fromCall: "OE8MSG-7", toCall: "OE3ABC", body: "QSL?", direction: "tx" }),
    ]);
  });
});
