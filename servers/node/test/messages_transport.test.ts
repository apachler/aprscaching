// SPDX-License-Identifier: AGPL-3.0-or-later
// Every message row says which network carried it: a received one the transport its ingest port maps to (the
// same as a position's), a sent one the radio that sent it. A row stored without one reads as none.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

const room = { fetch: async () => new Response(null, { status: 204 }) };
const ROOMS = { get: () => room };
const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const now = () => Math.floor(Date.now() / 1000) - 600;

const msg = (src: string, port: string, text: string, ts = now()) => ({
  src,
  dst: "APRS",
  path: [],
  payload: `:OE3DST   :${text}`,
  kind: "message",
  heardVia: port === "aprs-is" ? "aprs_is" : "rf",
  port,
  ts,
});

const list = async (env: Env) =>
  (await call(env, "GET", "/api/messages")).data.messages as { body: string; transport: string | null }[];
const transportOf = async (env: Env, body: string) => (await list(env)).find((m) => m.body === body)?.transport;

describe("message transport", () => {
  it("a received message records the transport of the port it came in on", async () => {
    const env = authEnv({ ROOMS });
    const ports = { "kiss-tnc": "tnc", agwpe: "tnc", meshcom: "meshcom", "aprs-is": "aprs-is", "made-up": "unknown" };
    const packets = Object.keys(ports).map((port, i) =>
      msg(`OE3TR${String.fromCharCode(65 + i)}`, port, `via ${port}`),
    );
    expect((await call(env, "POST", "/ingest", { packets }, SECRET)).status).toBe(200);
    for (const [port, transport] of Object.entries(ports))
      expect(await transportOf(env, `via ${port}`), port).toBe(transport);
  });

  it("a message sent from the browser radio is browser-rf, one a box sent is tnc", async () => {
    const env = authEnv({ ROOMS, ADMIN_CALLSIGNS: "OE8TRX" });
    const me = await emailSignup(env, "trx@example.test", "OE8TRX");
    await operatorVerify(env, "OE8TRX");
    const sent = await call(
      env,
      "POST",
      "/api/messages/sent",
      { from: "OE8TRX-7", to: "OE3ABC", text: "from the browser" },
      { cookie: me.cookie },
    );
    expect(sent.status).toBe(200);
    expect(await transportOf(env, "from the browser")).toBe("browser-rf");

    const cmd = await env.DB.prepare(
      "INSERT INTO box_commands (box_id, callsign, kind, payload, status, created_at) VALUES ('box-t', 'OE8TRX-9', 'message', ?, 'sent', ?)",
    )
      .bind(JSON.stringify({ to: "OE3ABC", text: "from the box" }), now())
      .run();
    const ack = await call(
      env,
      "POST",
      "/api/box/box-t/commands/ack",
      { id: Number(cmd.meta.last_row_id), status: "done" },
      SECRET,
    );
    expect(ack.status).toBe(200);
    expect(await transportOf(env, "from the box")).toBe("tnc");
  });

  it("a row stored without a transport lists with none", async () => {
    const env = authEnv({ ROOMS });
    await env.DB.prepare(
      "INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, 'OE3OLD', 'OE3DST', 'older', 'rx')",
    )
      .bind(now())
      .run();
    expect(await transportOf(env, "older")).toBeNull();
  });
});
