// SPDX-License-Identifier: AGPL-3.0-or-later
// What a message's sender reports of its repeats: the box for a message its radio or its APRS-IS uplink sent, the
// browser for one its radio sent. The Messages list shows the tries and how the message ended.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

const room = { fetch: async () => new Response(null, { status: 204 }) };
const ROOMS = { get: () => room };
const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const now = () => Math.floor(Date.now() / 1000) - 600;

type Listed = { body: string; delivery?: string; tries?: number; msgNo?: string | null };
const listed = async (env: Env, body: string) =>
  ((await call(env, "GET", "/api/messages")).data.messages as Listed[]).find((m) => m.body === body);

describe("message delivery reports", () => {
  it("a box message keeps its number, so the station's ack marks it, and its tries come with the report", async () => {
    const env = authEnv({ ROOMS });
    const cmd = await env.DB.prepare(
      "INSERT INTO box_commands (box_id, callsign, kind, payload, status, created_at) VALUES ('box-d', 'OE8DLV-9', 'message', ?, 'sent', ?)",
    )
      .bind(JSON.stringify({ to: "OE3ABC", text: "box repeats" }), now())
      .run();
    const id = Number(cmd.meta.last_row_id);
    expect(
      (await call(env, "POST", "/api/box/box-d/commands/ack", { id, status: "done", msgNo: "123" }, SECRET)).status,
    ).toBe(200);
    expect(await listed(env, "box repeats")).toMatchObject({ msgNo: "123", delivery: "sent" });

    const report = { id, delivery: { tries: 5, outcome: "expired" } };
    expect((await call(env, "POST", "/api/box/box-d/commands/ack", report, SECRET)).status).toBe(200);
    expect(await listed(env, "box repeats")).toMatchObject({ delivery: "unacked", tries: 5 });
    const log = await env.DB.prepare("SELECT result FROM box_commands WHERE id = ?")
      .bind(id)
      .first<{ result: string }>();
    expect(log!.result).toMatch(/never acknowledged after 5 tries/);

    // the station's ack, heard later, wins
    const ack = {
      src: "OE3ABC",
      dst: "APRS",
      path: [],
      payload: ":OE8DLV-9 :ack123",
      kind: "message",
      heardVia: "rf",
      port: "kiss-tnc",
      ts: now(),
    };
    expect((await call(env, "POST", "/ingest", { packets: [ack] }, SECRET)).status).toBe(200);
    expect(await listed(env, "box repeats")).toMatchObject({ delivery: "acked" });

    const bad = await call(
      env,
      "POST",
      "/api/box/box-d/commands/ack",
      { id, delivery: { tries: 0, outcome: "x" } },
      SECRET,
    );
    expect(bad.status).toBe(400);
  });

  it("the uplink reports how an APRS-IS message ended with its outbox ack", async () => {
    const env = authEnv({ ROOMS });
    const ob = await env.DB.prepare(
      "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload, target) VALUES (?, 'OE8DLV', 'APZACG', 'message', ':OE3ABC   :via is{7', 'is')",
    )
      .bind(now())
      .run();
    const outboxId = Number(ob.meta.last_row_id);
    await env.DB.prepare(
      "INSERT INTO messages (ts, from_call, to_call, body, ack, direction, transport, outbox_id) VALUES (?, 'OE8DLV', 'OE3ABC', 'via is', '7', 'tx', 'aprs-is', ?)",
    )
      .bind(now(), outboxId)
      .run();
    const r = await call(
      env,
      "POST",
      "/outbox/ack",
      { ids: [outboxId], deliveries: [{ id: outboxId, tries: 2, outcome: "acked" }] },
      SECRET,
    );
    expect(r.status).toBe(200);
    expect(await listed(env, "via is")).toMatchObject({ delivery: "acked", tries: 2 });
  });

  it("the browser reports a message its radio repeated, and the station's reject shows", async () => {
    const env = authEnv({ ROOMS, ADMIN_CALLSIGNS: "OE8DLB" });
    const me = await emailSignup(env, "dlb@example.test", "OE8DLB");
    await operatorVerify(env, "OE8DLB");
    const m = { from: "OE8DLB-7", to: "OE3ABC", text: "browser repeats", msgNo: "9" };
    expect((await call(env, "POST", "/api/messages/sent", m, { cookie: me.cookie })).status).toBe(200);
    const d = await call(
      env,
      "POST",
      "/api/messages/sent",
      { ...m, delivery: { tries: 3, outcome: "rejected" } },
      { cookie: me.cookie },
    );
    expect(d.status).toBe(200);
    expect(await listed(env, "browser repeats")).toMatchObject({ delivery: "rejected", tries: 3 });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'browser repeats'").first<{
      n: number;
    }>();
    expect(n!.n).toBe(1);
  });
});
