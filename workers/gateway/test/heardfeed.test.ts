// SPDX-License-Identifier: AGPL-3.0-or-later
// The pure parts of the read API's heard feed: the callsign list a stream takes, which calls a watch list covers,
// the event an ingested packet becomes, the SSE framing, and the rooms' in-process listeners it rides on.
import { describe, it, expect } from "vitest";
import { HEARD_STREAM_MAX_CALLS } from "@aprscaching/shared";
import { feedCall, heardEventOf, parseCalls, sseFrame, watches } from "../src/heardfeed.js";
import { RoomsCore } from "../src/rooms-core.js";
import type { LiveEnvelope } from "../src/live.js";

describe("heard feed callsigns", () => {
  it("takes a callsign with or without an SSID, in any case, and nothing else", () => {
    expect(feedCall(" oe8apr-9 ")).toBe("OE8APR-9");
    expect(feedCall("OE8APR")).toBe("OE8APR");
    expect(feedCall("OE8APR-123")).toBeNull();
    expect(feedCall("OE8 APR")).toBeNull();
    expect(feedCall("")).toBeNull();
  });

  it("parses a calls list once per call, and refuses an empty, malformed or too long one", () => {
    expect(parseCalls("oe8apr-9, OE8APR-9,dl1abc")).toEqual(["OE8APR-9", "DL1ABC"]);
    expect(parseCalls(null)).toHaveProperty("error");
    expect(parseCalls(" , ")).toHaveProperty("error");
    expect(parseCalls("OE8APR,<script>")).toHaveProperty("error");
    const many = Array.from({ length: HEARD_STREAM_MAX_CALLS + 1 }, (_, i) => `OE8A${i}`).join(",");
    expect(parseCalls(many)).toHaveProperty("error");
  });

  it("matches a call with an SSID exactly, and one without on every SSID of the base call", () => {
    expect(watches(["OE8APR-9"], "OE8APR-9")).toBe(true);
    expect(watches(["OE8APR-9"], "OE8APR-7")).toBe(false);
    expect(watches(["OE8APR-9"], "OE8APR")).toBe(false);
    expect(watches(["OE8APR"], "oe8apr-7")).toBe(true);
    expect(watches(["OE8APR"], "OE8APR")).toBe(true);
    expect(watches(["OE8APR"], "OE8APRX")).toBe(false);
  });
});

describe("heard events", () => {
  const p = { src: "oe8apr-9", ts: 1_700_000_000, heardVia: "rf" as const, path: ["WIDE1-1", "qAR", "OE8XGR-10"] };

  it("carries the station's own position and its route", () => {
    const ev = heardEventOf(p, { kind: "position" }, { lat: 47, lon: 15, symbol: "/>", course: 90, own: true });
    expect(ev).toEqual({
      type: "heard",
      callsign: "OE8APR-9",
      ts: 1_700_000_000,
      via: "rf",
      path: ["WIDE1-1", "qAR", "OE8XGR-10"],
      position: { lat: 47, lon: 15, symbol: "/>", course: 90 },
    });
  });

  it("leaves out the position of an object or item the station sent", () => {
    const ev = heardEventOf(p, { kind: "object" }, { lat: 47, lon: 15, own: false });
    expect(ev.position).toBeUndefined();
  });

  it("carries a status report's text", () => {
    const ev = heardEventOf(p, { kind: "status", text: "On the summit" }, null);
    expect(ev.status).toBe("On the summit");
    expect(ev.position).toBeUndefined();
  });

  it("frames an event for Server-Sent Events", () => {
    expect(sseFrame("heard", { a: 1 }, 5)).toBe('event: heard\nid: 5\ndata: {"a":1}\n\n');
    expect(sseFrame("snapshot", { a: 1 })).toBe('event: snapshot\ndata: {"a":1}\n\n');
  });
});

describe("room listeners", () => {
  it("see every dispatch of their region until they stop, and count per holder", () => {
    const rooms = new RoomsCore({ heartbeatMs: 0 });
    const seen: LiveEnvelope[][] = [];
    const stop = rooms.listen("global", "apikey:1", (e) => seen.push(e));
    const other = rooms.listen("global", "apikey:1", () => {
      throw new Error("a broken listener");
    });
    expect(rooms.holding("apikey:1")).toBe(2);
    expect(rooms.holding("apiip:x")).toBe(0);
    const batch: LiveEnvelope[] = [
      { heard: heardEventOf({ src: "OE8APR", ts: 1, heardVia: "rf", path: [] }, {}, null) },
    ];
    rooms.dispatch("global", batch);
    rooms.dispatch("elsewhere", batch);
    expect(seen).toEqual([batch]);
    stop();
    other();
    expect(rooms.holding("apikey:1")).toBe(0);
    rooms.dispatch("global", batch);
    expect(seen).toHaveLength(1);
  });
});
