// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { AppGeo, LogRequest, StageUnlockRequest } from "@aprscaching/shared";
import { handleLog } from "../src/caches.js";
import { handleUnlockStage } from "../src/stages.js";
import type { Env } from "../src/env.js";

// The in-app location evidence is a device reading: the log and the stage unlock take `appGeo` as
// {lat, lon, accuracyM, ts} and nothing else. There is no field that marks a typed ("manual")
// coordinate, so no request shape can carry one as evidence.
const READING = { lat: 47.07, lon: 15.42, accuracyM: 12, ts: 1_700_000_000 };

/** A request whose handler must refuse it before it touches the database. */
const post = (body: unknown) =>
  new Request("https://gw.test/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const NO_DB = {} as Env;

describe("the log path takes device readings only", () => {
  it("the evidence shape is exactly the device reading", () => {
    expect(Object.keys(AppGeo.shape).sort()).toEqual(["accuracyM", "lat", "lon", "ts"]);
    // `offline` only labels an unsigned queued log; it moves no time and is no evidence
    expect(Object.keys(LogRequest.shape).sort()).toEqual([
      "appGeo",
      "author",
      "comment",
      "logType",
      "loggerCall",
      "offline",
    ]);
  });

  it("rejects an appGeo that carries a source marker", () => {
    for (const extra of [{ source: "manual" }, { manual: true }, { typed: true }, { provider: "user" }])
      expect(LogRequest.safeParse({ logType: "found", appGeo: { ...READING, ...extra } }).success).toBe(false);
    expect(LogRequest.safeParse({ logType: "found", appGeo: READING }).success).toBe(true);
  });

  it("drops a top-level source marker rather than acting on it", () => {
    const r = LogRequest.safeParse({ logType: "found", appGeo: READING, source: "manual", manualGeo: READING });
    expect(r.success).toBe(true);
    expect(Object.keys(r.data!).sort()).toEqual(["appGeo", "logType"]);
  });

  it("handleLog answers 400 to a source-marked reading before any lookup", async () => {
    const res = await handleLog(post({ logType: "found", appGeo: { ...READING, source: "manual" } }), NO_DB, 1);
    expect(res.status).toBe(400);
  });
});

describe("the stage unlock takes device readings only", () => {
  it("accepts a bare reading and a full one", () => {
    expect(StageUnlockRequest.safeParse({ callsign: "OE8APR", appGeo: { lat: 47.1, lon: 15.5 } }).success).toBe(true);
    expect(StageUnlockRequest.safeParse({ callsign: "OE8APR", appGeo: READING }).success).toBe(true);
  });

  it("rejects a source-marked reading", async () => {
    const body = { callsign: "OE8APR", appGeo: { ...READING, source: "manual" } };
    expect(StageUnlockRequest.safeParse(body).success).toBe(false);
    const res = await handleUnlockStage(post(body), NO_DB, 1, 1);
    expect(res.status).toBe(400);
  });
});
