// SPDX-License-Identifier: AGPL-3.0-or-later
// The Mailbox: a message left for a callsign waits until its station is heard, goes out as a numbered APRS
// message from the service call, and is delivered once the station acks it. Separate from the BBS.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";
import { expireMailbox } from "@aprscaching/gateway/mailbox";
import { decideRadioCommand } from "@aprscaching/gateway/radiolog";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = "test-ingest-secret";

/** A packet from `src` over APRS-IS, as the ingest box posts it. */
async function heard(env: Env, src: string, payload: string) {
  const r = await call(
    env,
    "POST",
    "/ingest",
    {
      packets: [
        {
          src,
          dst: "APRS",
          path: ["TCPIP*", "qAC", "T2TEST"],
          payload,
          heardVia: "aprs_is",
          igateCall: "T2TEST",
          port: "aprs-is",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    },
    { "x-ingest-secret": SECRET },
  );
  expect(r.status).toBe(200);
}

const outbox = async (env: Env) =>
  (
    await env.DB.prepare("SELECT src_call, payload FROM aprs_outbox ORDER BY id").all<{
      src_call: string;
      payload: string;
    }>()
  ).results;

async function sender() {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR,OE1ABC,OE5XYZ", INGEST_SECRET: SECRET });
  const me = await emailSignup(env, "mail@example.test", "OE1ABC");
  await operatorVerify(env, "OE1ABC");
  const leave = (body: Record<string, unknown>) => call(env, "POST", "/api/mailbox", body, { cookie: me.cookie });
  return { env, me, leave };
}

describe("the Mailbox", () => {
  it("takes a message only under a verified call of the sender's, to a callsign, within one APRS message", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR,OE1ABC" });
    const me = await emailSignup(env, "mail@example.test", "OE1ABC");
    const leave = (body: Record<string, unknown>) => call(env, "POST", "/api/mailbox", body, { cookie: me.cookie });
    const msg = { from: "OE1ABC-7", to: "OE5XYZ", text: "see you at the field day" };
    expect((await call(env, "POST", "/api/mailbox", msg)).status).toBe(401);
    expect((await leave(msg)).status).toBe(403); // not verified yet
    await operatorVerify(env, "OE1ABC");
    expect((await leave({ ...msg, from: "DL1XYZ" })).status).toBe(403);
    expect((await leave({ ...msg, to: "APRSCG" })).status).toBe(400);
    expect((await leave({ ...msg, to: "OE8APR-15" })).status).toBe(400); // the service call itself
    expect((await leave({ ...msg, text: "x".repeat(60) })).status).toBe(400);
    expect((await leave(msg)).status).toBe(201);
    const list = (await call(env, "GET", "/api/mailbox", undefined, { cookie: me.cookie })).data;
    expect(list.sent).toEqual([expect.objectContaining({ to: "OE5XYZ", status: "held", via: "app" })]);
  });

  it("sends a message when any SSID of its base call is heard, and counts it delivered on the station's ack", async () => {
    const { env, leave } = await sender();
    expect((await leave({ from: "OE1ABC-7", to: "OE5XYZ", text: "QRV at 14z" })).status).toBe(201);
    await heard(env, "OE3OTH", ">someone else");
    expect(await outbox(env)).toEqual([]);
    await heard(env, "OE5XYZ-9", ">on the air");
    const [sent] = await outbox(env);
    expect(sent).toEqual({
      src_call: "OE8APR-15",
      payload: expect.stringMatching(/^:OE5XYZ-9 :de OE1ABC-7: QRV at 14z\{1$/),
    });
    const status = async () =>
      (await env.DB.prepare("SELECT status FROM mailbox_messages").first<{ status: string }>())?.status;
    expect(await status()).toBe("sent");
    await heard(env, "OE5XYZ-9", ":OE1ABC-7 :ack1"); // an ack to someone else
    expect(await status()).toBe("sent");
    await heard(env, "OE5XYZ-9", ":OE8APR-15:ack1");
    expect(await status()).toBe("delivered");
  });

  it("sends to a station heard on MeshCom through the box's node, and takes only the KISS port's ack", async () => {
    const { env, leave } = await sender();
    await leave({ from: "OE1ABC", to: "OE5XYZ", text: "via the mesh" });
    await call(env, "GET", "/api/box/pi-home/commands?tx=1&rf=0&meshcom=OE8APR-12&kiss=OE8APR-12", undefined, {
      "x-ingest-secret": SECRET,
    });
    const meshcom = (payload: string, port = "meshcom") =>
      call(
        env,
        "POST",
        "/ingest",
        {
          packets: [
            {
              src: "OE5XYZ-7",
              dst: "APRS",
              path: [],
              payload,
              heardVia: "rf",
              port,
              box: "pi-home",
              rxCall: "OE8APR-12",
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        },
        { "x-ingest-secret": SECRET },
      );
    await meshcom(">on the mesh");
    const cmd = await env.DB.prepare("SELECT kind, payload FROM box_commands").first<{
      kind: string;
      payload: string;
    }>();
    expect(cmd?.kind).toBe("meshcom_msg");
    expect(JSON.parse(cmd!.payload)).toEqual({
      node: "OE8APR-12",
      dst: "OE5XYZ-7",
      text: "de OE1ABC: via the mesh",
      from: "OE8APR-15",
      msgNo: "1",
    });
    expect(await outbox(env)).toEqual([]);
    const status = async () =>
      (await env.DB.prepare("SELECT status FROM mailbox_messages").first<{ status: string }>())?.status;
    await meshcom(":OE8APR-15:ack1"); // over ExtUDP the number is the node's own, not ours
    expect(await status()).toBe("sent");
    await meshcom(":OE8APR-15:ack1", "meshcom-kiss");
    expect(await status()).toBe("delivered");

    // a box without the node's KISS port: sent once under the node's call, never repeated
    await leave({ from: "OE1ABC", to: "OE5XYZ", text: "once only" });
    await call(env, "GET", "/api/box/pi-home/commands?tx=1&rf=0&meshcom=OE8APR-12", undefined, {
      "x-ingest-secret": SECRET,
    });
    await meshcom(">still here");
    const last = await env.DB.prepare("SELECT status, attempts FROM mailbox_messages WHERE body = 'once only'").first();
    expect(last).toEqual({ status: "undelivered", attempts: 5 });
  });

  it("waits for the exact station when the message names an SSID", async () => {
    const { env, leave } = await sender();
    await leave({ from: "OE1ABC", to: "OE5XYZ-7", text: "for the handheld" });
    await heard(env, "OE5XYZ-9", ">the car");
    expect(await outbox(env)).toEqual([]);
    await heard(env, "OE5XYZ-7", ">the handheld");
    expect(await outbox(env)).toHaveLength(1);
  });

  it("takes MAIL by radio, held at once from a signed device and confirmed in the app otherwise", async () => {
    const { env, me } = await sender();
    await heard(env, "OE1ABC-7", ":OE8APR-15:MAIL OE5XYZ hi from the summit{7");
    const row = await env.DB.prepare("SELECT id, status FROM radio_commands WHERE command = 'mail'").first<{
      id: number;
      status: string;
    }>();
    expect(row?.status).toBe("pending"); // over APRS-IS: the sender confirms it
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mailbox_messages").first()).toEqual({ n: 0 });
    const acct = (await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign = 'OE1ABC'").first<{
      account_id: string;
    }>())!.account_id;
    expect((await decideRadioCommand(env, acct, row!.id, "confirm")).status).toBe(200);
    const list = (await call(env, "GET", "/api/mailbox", undefined, { cookie: me.cookie })).data;
    expect(list.sent).toEqual([
      expect.objectContaining({ from: "OE1ABC-7", to: "OE5XYZ", text: "hi from the summit", via: "radio" }),
    ]);
  });

  it("expires a message after its week, lets the sender withdraw one, and lists it for the addressee", async () => {
    const { env, leave } = await sender();
    const them = await emailSignup(env, "them@example.test", "OE5XYZ");
    const id = (await leave({ from: "OE1ABC", to: "OE5XYZ", text: "one" })).data.id;
    await leave({ from: "OE1ABC", to: "OE5XYZ", text: "two" });
    const theirs = (await call(env, "GET", "/api/mailbox", undefined, { cookie: them.cookie })).data;
    expect(theirs.received.map((m: { text: string }) => m.text).sort()).toEqual(["one", "two"]);
    expect((await call(env, "DELETE", `/api/mailbox/${id}`, undefined, { cookie: them.cookie })).status).toBe(404);
    await env.DB.prepare("UPDATE mailbox_messages SET expires_at = ?")
      .bind(Math.floor(Date.now() / 1000) - 60)
      .run();
    await expireMailbox(env);
    expect(
      (await env.DB.prepare("SELECT status FROM mailbox_messages").all<{ status: string }>()).results.map(
        (r) => r.status,
      ),
    ).toEqual(["expired", "expired"]);
    // settled messages stay listed for a month, then go
    await env.DB.prepare("UPDATE mailbox_messages SET expires_at = 1").run();
    await expireMailbox(env);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mailbox_messages").first()).toEqual({ n: 0 });
  });
});
