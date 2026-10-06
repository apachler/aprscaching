// SPDX-License-Identifier: AGPL-3.0-or-later
// MeshCom group chat: stored from the operator's own ingest only, once however many nodes or paths delivered
// it, kept out of the callsign message log, read per group newest first, and pruned with the message log.
import { describe, it, expect, vi } from "vitest";
import { authEnv, call } from "./helpers/authflow.js";
import { runScheduled } from "@aprscaching/gateway/app";
import type { Env } from "@aprscaching/gateway/env";

const room = { fetch: async () => new Response(null, { status: 204 }) };
const ROOMS = { get: () => room };
const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const now = () => Math.floor(Date.now() / 1000) - 1200;

type Meta = Record<string, unknown>;
const group = (src: string, grp: string, text: string, meta: Meta | null, ts = now(), rxCall = "OE8APR-12") => ({
  src,
  dst: "APRS",
  path: [],
  payload: `{MG${grp}:${text}`,
  kind: "other",
  heardVia: meta?.srcType === "udp" ? "aprs_is" : "rf",
  port: "meshcom",
  rxCall,
  ts,
  ...(meta ? { parsed: { meshcom: meta } } : {}),
});
const lora = (receiver: string, msgId = "0A1B2C3D", over: Meta = {}): Meta => ({
  srcType: "lora",
  direct: true,
  path: ["OE8GRP-1"],
  receiver,
  msgId,
  ...over,
});

async function ingest(env: Env, packets: unknown[]) {
  expect((await call(env, "POST", "/ingest", { packets }, SECRET)).status).toBe(200);
}
const rows = (env: Env) =>
  env.DB.prepare("SELECT from_call, grp, body, receiver, heard FROM meshcom_group_messages ORDER BY id")
    .all<Record<string, unknown>>()
    .then((r) => r.results);

describe("MeshCom group messages", () => {
  it("are stored once across nodes, server echoes and repeats; a more direct hearing replaces how it was heard", async () => {
    const env = authEnv({ ROOMS });
    const ts = now();
    await ingest(env, [
      group("OE8GRP-1", "232", "QRV on 2m?", lora("OE8APR-12", "AB12", { srcType: "udp", direct: false }), ts),
    ]);
    await ingest(env, [
      group("OE8GRP-1", "232", "QRV on 2m?", lora("OE8APR-12", "AB12"), ts + 2),
      group("OE8GRP-1", "232", "QRV on 2m?", lora("OE8NOD-12", "AB12"), ts + 3, "OE8NOD-12"),
    ]);
    await ingest(env, [group("OE8GRP-1", "232", "QRV on 2m?", lora("OE8APR-12", "AB12"), ts + 4)]);
    expect(await rows(env)).toEqual([
      { from_call: "OE8GRP-1", grp: "232", body: "QRV on 2m?", receiver: "OE8APR-12", heard: "direct" },
    ]);
    // a frame without an id is keyed on its text within ten minutes
    await ingest(env, [group("OE8GRP-2", "*", "CQ all", null, ts), group("OE8GRP-2", "*", "CQ all", null, ts)]);
    expect((await rows(env)).filter((r) => r.from_call === "OE8GRP-2")).toHaveLength(1);
  });

  it("stay out of the callsign Messages list and are taken only from the operator's own ingest", async () => {
    const env = authEnv({ ROOMS });
    await ingest(env, [group("OE8GRP-1", "232", "hello group", lora("OE8APR-12"))]);
    expect((await call(env, "GET", "/api/messages")).data.messages).toEqual([]);
    const signed = await call(env, "POST", "/ingest", { packets: [group("OE8GRP-3", "232", "x", null)] });
    expect(signed.status).toBe(401);
    expect(await rows(env)).toHaveLength(1);
  });

  it("list the groups heard with counts, and each group's messages newest first, paged", async () => {
    const env = authEnv({ ROOMS });
    const ts = now();
    await ingest(
      env,
      [1, 2, 3, 4, 5].map((i) => group("OE8GRP-1", "232", `m${i}`, lora("OE8APR-12", `A${i}`), ts + i)),
    );
    await ingest(env, [group("OE8GRP-2", "9", "nine", lora("OE8APR-12", "B1"), ts)]);

    const groups = (await call(env, "GET", "/api/meshcom/groups")).data.groups;
    expect(groups).toEqual([
      { group: "232", messages: 5, lastHeard: ts + 5 },
      { group: "9", messages: 1, lastHeard: ts },
    ]);

    const first = (await call(env, "GET", "/api/meshcom/groups/232/messages?limit=2")).data;
    expect(first.messages.map((m: { body: string }) => m.body)).toEqual(["m5", "m4"]);
    expect(first.hasMore).toBe(true);
    expect(first.messages[0]).toMatchObject({ fromCall: "OE8GRP-1", receiver: "OE8APR-12", heard: "direct" });
    const rest = (
      await call(env, "GET", `/api/meshcom/groups/232/messages?limit=10&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).data;
    expect(rest.messages.map((m: { body: string }) => m.body)).toEqual(["m3", "m2", "m1"]);
    expect(rest.hasMore).toBe(false);

    expect((await call(env, "GET", "/api/meshcom/groups/0/messages")).status).toBe(400);
    expect((await call(env, "GET", "/api/meshcom/groups/%2A/messages")).data.messages).toEqual([]);
  });

  it("are pruned nightly with the message log", async () => {
    const env = authEnv({ ROOMS });
    await ingest(env, [group("OE8GRP-1", "232", "old", lora("OE8APR-12"))]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 8 * 24 * 3600 * 1000);
      await runScheduled(env);
    } finally {
      vi.useRealTimers();
    }
    expect(await rows(env)).toEqual([]);
  });
});
