// SPDX-License-Identifier: AGPL-3.0-or-later
// The instance's service call: the sysop's call with SSID 15 unless SERVICE_CALL names another, the ingest
// box told it, radio commands taken on it, and held mail confirmed only by an ack addressed to it.
import { describe, it, expect } from "vitest";
import { serviceCall } from "@aprscaching/gateway/servicecall";
import { handleIngest, handleIngestCheck } from "@aprscaching/gateway/ingest";
import type { Env } from "@aprscaching/gateway/env";
import { freshDb, instanceEnv } from "./helpers/fedpeer.js";

const env = (extra: Record<string, string> = {}) => ({ ...extra }) as unknown as Env;

describe("service call", () => {
  it("is the first sysop's base call with SSID 15", () => {
    expect(serviceCall(env({ ADMIN_CALLSIGNS: "oe8apr-7, OE1ABC" }))).toBe("OE8APR-15");
  });
  it("is SERVICE_CALL when set", () => {
    expect(serviceCall(env({ ADMIN_CALLSIGNS: "OE8APR", SERVICE_CALL: "oe8apr-12" }))).toBe("OE8APR-12");
  });
  it("is APRSCG on an instance with no sysop, or one whose base call cannot carry an SSID on air", () => {
    expect(serviceCall(env())).toBe("APRSCG");
    expect(serviceCall(env({ ADMIN_CALLSIGNS: "OE8ABCDE" }))).toBe("APRSCG");
  });
  it("is named to the ingest box by the credential check", async () => {
    const e = env({ ADMIN_CALLSIGNS: "OE8APR", INGEST_SECRET: "s" });
    const r = handleIngestCheck(new Request("http://gw/ingest/check", { headers: { "x-ingest-secret": "s" } }), e);
    expect(await r.json()).toMatchObject({ ok: true, serviceCall: "OE8APR-15" });
  });
});

describe("radio traffic to the service call", () => {
  function gateway() {
    const { sqlite, DB } = freshDb();
    const e = instanceEnv("gw.test", null, { ADMIN_CALLSIGNS: "OE8APR" }, DB);
    return { sqlite, env: e };
  }
  async function ingest(e: Env, src: string, payload: string) {
    const res = await handleIngest(
      new Request("http://gw/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": "test-ingest-secret" },
        body: JSON.stringify({
          packets: [
            {
              src,
              dst: "APRS",
              path: ["WIDE1-1", "qAR", "OE3XIG"],
              payload,
              heardVia: "aprs_is",
              igateCall: "OE3XIG",
              port: "aprs-is",
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      }),
      e,
      { waitUntil: () => {} } as never,
    );
    expect(res.status).toBe(200);
  }

  it("takes a radio command addressed to the service call, and not one to APRSCG", async () => {
    const gw = gateway();
    await ingest(gw.env, "OE5XYZ-7", ":OE8APR-15:HELP{3");
    await ingest(gw.env, "OE5XYZ-7", ":APRSCG   :HELP{4");
    const rows = gw.sqlite.prepare("SELECT from_call FROM radio_commands").all();
    expect(rows).toEqual([expect.objectContaining({ from_call: "OE5XYZ-7" })]);
  });

  it("marks held mail delivered only on an ack addressed to the service call", async () => {
    const gw = gateway();
    gw.sqlite.exec(
      "INSERT INTO bbs_delivery (msg_id, to_call, line_no, attempts, status) VALUES (1, 'OE5XYZ-7', 7, 1, 'sent')",
    );
    const status = () =>
      (gw.sqlite.prepare("SELECT status FROM bbs_delivery WHERE msg_id = 1").get() as { status: string }).status;
    await ingest(gw.env, "OE5XYZ-7", ":OE8APR   :ack7"); // the sysop's own traffic, not the mailbox's
    expect(status()).toBe("sent");
    await ingest(gw.env, "OE5XYZ-7", ":OE8APR-15:ack7");
    expect(status()).toBe("acked");
  });
});
