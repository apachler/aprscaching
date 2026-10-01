// SPDX-License-Identifier: AGPL-3.0-or-later
// A callsign's BBS mailbox is its holder's. The web routes read and write personal mail only for a
// session whose account holds the call, or for the ingest box (INGEST_SECRET), which carries mail for
// the stations it hears and forwards. A White Pages entry steers FBB forwarding, so only the ingest box
// and the operator set one. Bulletins stay public.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const OPERATOR = { "x-operator-secret": "test-operator-secret" };

async function twoOperators() {
  const env = authEnv();
  const alice = await emailSignup(env, "alice@example.test", "OE1AAA");
  const bob = await emailSignup(env, "bob@example.test", "OE2BBB");
  expect(alice.status).toBe(200);
  expect(bob.status).toBe(200);
  return { env, alice: { cookie: alice.cookie }, bob: { cookie: bob.cookie } };
}

describe("posting BBS mail", () => {
  it("needs a session or the ingest secret", async () => {
    const { env } = await twoOperators();
    const r = await call(env, "POST", "/api/bbs/messages", { fromCall: "OE1AAA", toCall: "OE2BBB", body: "hi" });
    expect(r.status).toBe(401);
  });

  it("is sent only in the name of a call the session's account holds", async () => {
    const { env, alice } = await twoOperators();
    const forged = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE2BBB", toCall: "OE1AAA", body: "spoofed" },
      alice,
    );
    expect(forged.status).toBe(403);
    const own = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE1AAA-7", toCall: "OE2BBB", body: "from my handheld" },
      alice,
    );
    expect(own.status).toBe(201);
  });

  it("the ingest box posts for any station", async () => {
    const { env } = await twoOperators();
    const r = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE9XYZ", toCall: "OE2BBB", body: "rf" },
      INGEST,
    );
    expect(r.status).toBe(201);
  });

  it("a wrong ingest secret is refused, not treated as a visitor", async () => {
    const { env } = await twoOperators();
    const r = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE9XYZ", toCall: "OE2BBB", body: "rf" },
      { "x-ingest-secret": "nope" },
    );
    expect(r.status).toBe(401);
  });
});

describe("reading a mailbox", () => {
  it("the inbox and the sent list are their holder's", async () => {
    const { env, alice, bob } = await twoOperators();
    await call(env, "POST", "/api/bbs/messages", { fromCall: "OE1AAA", toCall: "OE2BBB", body: "private" }, alice);

    expect((await call(env, "GET", "/api/bbs/messages?to=OE2BBB")).status).toBe(401);
    expect((await call(env, "GET", "/api/bbs/messages?to=OE2BBB", undefined, alice)).status).toBe(403);
    const inbox = await call(env, "GET", "/api/bbs/messages?to=OE2BBB", undefined, bob);
    expect(inbox.status).toBe(200);
    expect(inbox.data.messages.map((m: { body: string }) => m.body)).toContain("private");

    expect((await call(env, "GET", "/api/bbs/sent?from=OE1AAA", undefined, bob)).status).toBe(403);
    expect((await call(env, "GET", "/api/bbs/sent?from=OE1AAA", undefined, alice)).status).toBe(200);
    expect((await call(env, "GET", "/api/bbs/messages?to=OE2BBB", undefined, INGEST)).status).toBe(200);
  });

  it("only the addressee marks a message read", async () => {
    const { env, alice, bob } = await twoOperators();
    const post = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE1AAA", toCall: "OE2BBB", body: "x" },
      alice,
    );
    const id = post.data.id as number;
    expect((await call(env, "POST", `/api/bbs/messages/${id}/read`)).status).toBe(401);
    expect((await call(env, "POST", `/api/bbs/messages/${id}/read`, undefined, alice)).status).toBe(403);
    expect((await call(env, "POST", `/api/bbs/messages/${id}/read`, undefined, bob)).status).toBe(200);
    expect((await call(env, "POST", "/api/bbs/messages/999999/read", undefined, bob)).status).toBe(404);
  });

  it("a thread shows personal mail only to its parties, and bulletins to everyone", async () => {
    const { env, alice, bob } = await twoOperators();
    const carol = await emailSignup(env, "carol@example.test", "OE3CCC");
    const p = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE1AAA", toCall: "OE2BBB", body: "secret" },
      alice,
    );
    const id = p.data.id as number;
    const asParty = await call(env, "GET", `/api/bbs/thread/${id}`, undefined, bob);
    expect(asParty.data.messages).toHaveLength(1);
    const asStranger = await call(env, "GET", `/api/bbs/thread/${id}`, undefined, { cookie: carol.cookie });
    expect(asStranger.data.messages).toHaveLength(0);
    expect((await call(env, "GET", `/api/bbs/thread/${id}`)).data.messages).toHaveLength(0);

    const b = await call(env, "POST", "/api/bbs/messages", { fromCall: "OE1AAA", toCall: "ALL", body: "news" }, alice);
    const bull = await call(env, "GET", `/api/bbs/thread/${b.data.id}`);
    expect(bull.data.messages).toHaveLength(1);
    expect((await call(env, "GET", "/api/bbs/bulletins")).status).toBe(200);
  });

  it("a hierarchical address is the mailbox of its callsign", async () => {
    const { env, bob } = await twoOperators();
    const r = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE9XYZ", toCall: "OE2BBB @ OE2BBS.OE.EU", body: "via hierarchy" },
      INGEST,
    );
    expect((await call(env, "POST", `/api/bbs/messages/${r.data.id}/read`, undefined, bob)).status).toBe(200);
  });
});

describe("White Pages", () => {
  it("anyone looks an entry up; only the ingest box and the operator set one", async () => {
    const { env, alice } = await twoOperators();
    const entry = { callsign: "OE2BBB", homeBbs: "OE1EVL.OE.EU" };
    expect((await call(env, "POST", "/api/bbs/wp", entry)).status).toBe(403);
    expect((await call(env, "POST", "/api/bbs/wp", entry, alice)).status).toBe(403);
    expect((await call(env, "POST", "/api/bbs/wp", entry, { "x-ingest-secret": "nope" })).status).toBe(401);
    expect((await call(env, "POST", "/api/bbs/wp", entry, INGEST)).status).toBe(200);
    expect(
      (await call(env, "POST", "/api/bbs/wp", { callsign: "OE2BBB", homeBbs: "OE2X.OE.EU" }, OPERATOR)).status,
    ).toBe(200);
    const look = await call(env, "GET", "/api/bbs/wp?call=OE2BBB");
    expect(look.status).toBe(200);
    expect(look.data.homeBbs).toBe("OE2X.OE.EU");
  });
});
