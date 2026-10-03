// SPDX-License-Identifier: AGPL-3.0-or-later
// A local BBS message carries an FBB BID of at most 12 characters, `<id in base 36>_<sysop base call>`, so a
// real F6FBB partner takes it. Only this BBS issues BIDs with its call: one arriving by forwarding is dropped.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };

describe("FBB BIDs", () => {
  it("are issued as <id>_<sysop base call>, within 12 characters", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const alice = await emailSignup(env, "alice@example.test", "OE1AAA");
    const r = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE1AAA", toCall: "OE2BBB", body: "hi" },
      {
        cookie: alice.cookie,
      },
    );
    expect(r.status).toBe(201);
    expect(r.data.bid).toBe(`${Number(r.data.id).toString(36).toUpperCase()}_OE8APR`);
    expect(r.data.bid.length).toBeLessThanOrEqual(12);
  });

  it("drop a forwarded message under a BID of this BBS, so it cannot claim one the BBS has yet to issue", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const inbound = (bid: string) =>
      call(
        env,
        "POST",
        "/api/bbs/forward/inbound",
        { message: { bid, type: "P", from: "DL1ABC", to: "OE1AAA", title: "hi", body: "x" } },
        INGEST,
      );
    expect((await inbound("1_OE8APR")).data).toMatchObject({ stored: 0, deduped: true });
    expect((await inbound("1_DB0ABC")).data).toMatchObject({ stored: 1 });
    const alice = await emailSignup(env, "alice@example.test", "OE1AAA");
    const r = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE1AAA", toCall: "OE2BBB", body: "mine" },
      {
        cookie: alice.cookie,
      },
    );
    expect(r.status).toBe(201);
    expect(r.data.bid).toMatch(/_OE8APR$/);
  });
});
