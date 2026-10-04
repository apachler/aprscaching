// SPDX-License-Identifier: AGPL-3.0-or-later
// What the public surfaces hold back: the activity feeds leave unlisted caches out, an API key names an owner
// only for a session holding that call, a box never collects a command queued too long ago, and a media object
// has one key.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import { addCache } from "./helpers/fedpeer.js";
import { handleBoxPoll } from "@aprscaching/gateway/box";
import { makeFsMedia } from "../src/media.js";

const BOX_COMMAND_QUEUED_TTL_S = 3600; // the gateway's queue window for box commands

describe("the activity feed", () => {
  it("leaves finds on unlisted caches out, on both routes", async () => {
    const env = authEnv();
    const listed = await addCache(env);
    const unlisted = await addCache(env);
    await env.DB.prepare("UPDATE caches SET fed_scope='unlisted' WHERE id=?").bind(unlisted).run();
    for (const id of [listed, unlisted])
      await env.DB.prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, 'DL1ACT', 1700000000, 'found', 1)",
      )
        .bind(id)
        .run();
    for (const path of ["/api/activity", "/api/v1/activity"]) {
      const res = await call(env, "GET", path);
      expect(res.status, path).toBe(200);
      expect(
        res.data.activity.map((a: { cacheId: number }) => a.cacheId),
        path,
      ).toEqual([listed]);
    }
  });
});

describe("a free API key", () => {
  it("names its owner only for a session whose account holds the call", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "keys@example.test", "DL1KEY");
    expect(me.status).toBe(200);
    const owner = async (body: unknown, headers: Record<string, string> = {}) => {
      const res = await call(env, "POST", "/api/v1/keys", body, headers);
      expect(res.status).toBe(201);
      return (await call(env, "GET", `/api/v1/keys/${res.data.key}`)).data.ownerCall;
    };
    expect(await owner({ ownerCall: "DL1KEY" })).toBeNull();
    expect(await owner({ ownerCall: "OE8APR" }, { cookie: me.cookie })).toBeNull();
    expect(await owner({ ownerCall: "dl1key-7" }, { cookie: me.cookie })).toBe("DL1KEY-7");
    expect(await owner({}, { cookie: me.cookie })).toBeNull();
  });
});

describe("a queued box command", () => {
  it("is handed out while fresh and expired once older than the queue window", async () => {
    const env = authEnv({ INGEST_SECRET: "s" });
    const now = Math.floor(Date.now() / 1000);
    for (const [kind, at] of [
      ["beacon", now - BOX_COMMAND_QUEUED_TTL_S - 60],
      ["status", now - 60],
    ] as const)
      await env.DB.prepare(
        "INSERT INTO box_commands (box_id, callsign, kind, payload, created_at) VALUES ('pi-home', 'DL1BOX', ?, NULL, ?)",
      )
        .bind(kind, at)
        .run();
    const res = await handleBoxPoll(
      new Request("https://gw.test/api/box/pi-home/commands", { headers: { "x-ingest-secret": "s" } }),
      env,
      "pi-home",
    );
    const body = (await res.json()) as { commands: { kind: string }[] };
    expect(body.commands.map((c) => c.kind)).toEqual(["status"]);
    const states = (
      await env.DB.prepare("SELECT kind, status FROM box_commands ORDER BY id").all<{ kind: string; status: string }>()
    ).results;
    expect(states).toEqual([
      { kind: "beacon", status: "expired" },
      { kind: "status", status: "sent" },
    ]);
  });
});

describe("the filesystem media store", () => {
  it("takes each object under one key only: no empty or dot segments", async () => {
    const store = makeFsMedia(fs.mkdtempSync(path.join(os.tmpdir(), "media-")));
    await store.put("cache/1/stage/2/clue-00000000000a.mpeg", new Uint8Array([1]), "audio/mpeg");
    expect(await store.get("cache/1/stage/2/clue-00000000000a.mpeg")).not.toBeNull();
    for (const key of [
      "cache//1/stage/2/clue-00000000000a.mpeg",
      "cache/./1/stage/2/clue-00000000000a.mpeg",
      "cache/1/stage/2/",
    ])
      await expect(store.get(key), key).rejects.toThrow(/unsafe media key/);
  });
});
