// SPDX-License-Identifier: AGPL-3.0-or-later
// The ingest mirrors its NET/ROM routing table to POST /api/node/nodes in one batch: the gateway stores the
// valid routes and names the refused ones, so one bad record never costs the others.
import { describe, it, expect } from "vitest";
import { authEnv, call } from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const route = (dest: string, alias = "X") => ({ dest, alias, neighbor: "OE1NBR-7", quality: 192, port: "kiss-tnc" });
const dests = async (env: ReturnType<typeof authEnv>) =>
  ((await call(env, "GET", "/api/node/nodes")).data.nodes as { dest: string; alias: string }[]).map((n) => n.dest);

describe("POST /api/node/nodes batch", () => {
  it("stores the valid routes of a batch and names the refused one", async () => {
    const env = authEnv();
    const r = await call(
      env,
      "POST",
      "/api/node/nodes",
      { nodes: [route("OE1AAA-7"), { dest: "OE1BAD-7", alias: "B" }, route("OE1CCC-7")] },
      INGEST,
    );
    expect(r.status).toBe(201);
    expect(r.data.stored).toBe(2);
    expect(r.data.refused).toEqual([{ index: 1, dest: "OE1BAD-7", error: "dest + neighbor required" }]);
    expect((await dests(env)).sort()).toEqual(["OE1AAA-7", "OE1CCC-7"]);
  });

  it("keeps a node with a blank alias, as NET/ROM allows", async () => {
    const env = authEnv();
    const r = await call(env, "POST", "/api/node/nodes", { nodes: [route("OE1NOA-7", "")] }, INGEST);
    expect(r.data).toMatchObject({ stored: 1, refused: [] });
    expect(await dests(env)).toEqual(["OE1NOA-7"]);
  });

  it("takes 500 routes in one request and refuses 501 with 413", async () => {
    const env = authEnv();
    const many = (n: number) => Array.from({ length: n }, (_, i) => route(`OE${String(i).padStart(4, "0")}`));
    const ok = await call(env, "POST", "/api/node/nodes", { nodes: many(500) }, INGEST);
    expect(ok.data.stored).toBe(500);
    const over = await call(env, "POST", "/api/node/nodes", { nodes: many(501) }, INGEST);
    expect(over.status).toBe(413);
  });
});
