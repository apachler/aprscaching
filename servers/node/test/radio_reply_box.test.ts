// SPDX-License-Identifier: AGPL-3.0-or-later
// Which transmitter answers a radio command: only the enrolled box whose own signature delivered the packet. A box
// the packet names is a routing hint that box's signature alone can back, so neither the shared ingest secret nor
// another box's key can key up a transmitter at a site it never heard.
import { describe, it, expect } from "vitest";
import { authEnv, call } from "./helpers/authflow.js";
import { boxCall, keyedBox, signedCall } from "./helpers/box.js";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = "test-ingest-secret";

/** HELP from OE8APR-7 to the service call, heard on a box's TNC: always answered, with an ack and the help text. */
const help = (box: string) => ({
  packets: [
    {
      src: "OE8APR-7",
      dst: "APRS",
      path: ["WIDE1-1"],
      payload: ":OE8APR-15:HELP{12",
      heardVia: "rf",
      igateCall: "OE8XXX-10",
      port: "kiss-tnc",
      box,
      ts: Math.floor(Date.now() / 1000),
    },
  ],
});

/** Two enrolled boxes, each polling with a transmitter on its radio. */
async function twoBoxes() {
  const env = authEnv({ INGEST_SECRET: SECRET, RADIO_REPLIES: "1", SERVICE_CALL: "OE8APR-15" });
  for (const box of ["pi-a", "pi-b"])
    expect((await boxCall(env, box, "GET", `/api/box/${box}/commands?tx=1&rf=1`)).status).toBe(200);
  return env;
}

const boxCommands = async (env: Env) =>
  (await env.DB.prepare("SELECT box_id, kind FROM box_commands ORDER BY id").all<{ box_id: string; kind: string }>())
    .results;
const outbox = async (env: Env) =>
  (await env.DB.prepare("SELECT payload FROM aprs_outbox ORDER BY id").all<{ payload: string }>()).results.map(
    (r) => r.payload,
  );

describe("a radio command's answer", () => {
  it("goes out through the enrolled box whose signature delivered it", async () => {
    const env = await twoBoxes();
    expect((await signedCall(env, await keyedBox(env, "pi-a"), "POST", "/ingest", help("pi-a"))).status).toBe(200);
    expect(await boxCommands(env)).toEqual([
      { box_id: "pi-a", kind: "aprs_msg" },
      { box_id: "pi-a", kind: "aprs_msg" },
    ]);
    expect(await outbox(env)).toEqual([]);
  });

  it("never goes through a box another box's packet names", async () => {
    const env = await twoBoxes();
    expect((await signedCall(env, await keyedBox(env, "pi-a"), "POST", "/ingest", help("pi-b"))).status).toBe(200);
    expect(await boxCommands(env)).toEqual([]);
  });

  it("never goes through a box a packet on the shared secret names", async () => {
    const env = await twoBoxes();
    expect((await call(env, "POST", "/ingest", help("pi-a"), { "x-ingest-secret": SECRET })).status).toBe(200);
    expect(await boxCommands(env)).toEqual([]);
    // the command is still handled: its ack and the help text leave over APRS-IS, through no transmitter
    expect(await outbox(env)).toEqual([":OE8APR-7 :ack12", expect.stringMatching(/^:OE8APR-7 :FOUND\/DNF\/NOTE/)]);
  });
});

describe("what /ingest/check tells a box about its services", () => {
  it("says whether the sysop lets an enrolled box run this instance's services, and nothing on the secret", async () => {
    const env = authEnv({ INGEST_SECRET: SECRET });
    expect((await boxCall(env, "pi-a", "GET", "/ingest/check")).data).toMatchObject({ box: "pi-a", services: false });
    expect((await boxCall(env, "pi-b", "GET", "/ingest/check", undefined, { services: true })).data).toMatchObject({
      box: "pi-b",
      services: true,
    });
    const secret = await call(env, "GET", "/ingest/check", undefined, { "x-ingest-secret": SECRET });
    expect(secret.data).toMatchObject({ box: null, services: null });
  });
});
