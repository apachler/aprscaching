// SPDX-License-Identifier: AGPL-3.0-or-later
// CoT (Cursor-on-Target) bridge for TAK clients: the pure <event> builder + symbol mapping, plus the
// SSE push feed which streams the current snapshot then pushes deltas. The stream is a ReadableStream
// (Workers/Bun stream it natively; the Node shell pipes text/event-stream) so we can read it here.
import { describe, it, expect } from "vitest";
import { stationToCotEvent, cotType, handleCot, handleCotStream } from "../src/cot.js";
import type { Env } from "../src/env.js";

const station = (over: Record<string, unknown> = {}) => ({
  callsign: "OE8TEST",
  lat: 47.07,
  lon: 15.42,
  symbol: "/>" as string | null,
  course: 90 as number | null,
  speedKn: 10 as number | null,
  altitudeM: null as number | null,
  comment: "mobile" as string | null,
  lastSeen: 1000,
  ...over,
});

describe("CoT event builder", () => {
  it("emits a well-formed <event> with contact + track + remarks", () => {
    const xml = stationToCotEvent(station(), 2000);
    expect(xml).toContain('uid="APRS.OE8TEST"');
    expect(xml).toContain('type="a-f-G-E-V-C"'); // ">" = ground vehicle
    expect(xml).toContain('<contact callsign="OE8TEST"/>');
    expect(xml).toContain("<track ");
    expect(xml).toContain("mobile");
  });

  it("XML-escapes hostile callsigns/comments (no injection into the CoT document)", () => {
    const xml = stationToCotEvent(station({ callsign: 'A<b>&"', comment: "</detail>" }), 2000);
    expect(xml).not.toContain("<b>");
    expect(xml).toContain("&lt;b&gt;");
    expect(xml).not.toContain("</detail></detail>");
  });

  it("a station stays live on TAK until its next stored beacon is due", () => {
    const stale = (xml: string) => /stale="([^"]+)"/.exec(xml)![1];
    expect(stale(stationToCotEvent(station(), 2000))).toBe(new Date((1000 + 300) * 1000).toISOString());
    expect(stale(stationToCotEvent(station(), 2000, 900))).toBe(new Date((1000 + 900) * 1000).toISOString());
  });

  it("maps symbols to coarse CoT types", () => {
    expect(cotType("/_")).toBe("a-f-G-I-U-T"); // weather
    expect(cotType("/O")).toBe("a-f-A"); // aircraft (balloon)
    expect(cotType(null)).toBe("a-f-G-U-C"); // generic friendly
  });
});

describe("CoT snapshot (/api/cot)", () => {
  const db = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [station()] }) }) }),
  };
  const stale = async (extra: Record<string, string>) => {
    const res = await handleCot(new Request("http://gw/api/cot"), { DB: db, ...extra } as unknown as Env, 2000);
    return /stale="([^"]+)"/.exec(await res.text())![1];
  };
  const at = (s: number) => new Date(s * 1000).toISOString();

  it("allows for the position-storage interval: a stationary station's last_seen trails its beacons by up to it", async () => {
    expect(await stale({})).toBe(at(1000 + 300 + 600));
    expect(await stale({ POS_MIN_INTERVAL_S: "1200" })).toBe(at(1000 + 300 + 1200));
    expect(await stale({ POS_MIN_INTERVAL_S: "0" })).toBe(at(1000 + 300));
  });
});

describe("CoT SSE stream (/api/cot/stream)", () => {
  // Mock DB: the snapshot query ("last_seen >= ?") returns one station; delta polls ("last_seen > ?") empty.
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          async all() {
            return { results: sql.includes("last_seen >= ?") ? [station()] : [] };
          },
        }),
      }),
    },
  } as unknown as Env;

  it("returns an event-stream response and pushes the snapshot as CoT frames", async () => {
    const res = handleCotStream(new Request("http://gw/api/cot/stream"), env, 5000);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    // read until the snapshot marker (emitted immediately, before the first poll sleep)
    for (let i = 0; i < 20 && !buf.includes(": snapshot"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    await reader.cancel(); // client disconnect → stream stops
    expect(buf).toContain("event: cot\n");
    expect(buf).toContain('uid="APRS.OE8TEST"');
    expect(buf).toContain(": snapshot 1");
  });
});
