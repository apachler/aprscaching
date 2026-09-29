// SPDX-License-Identifier: AGPL-3.0-or-later
// The in-memory region rooms the self-host runtimes (Node over `ws`, Bun over Bun.serve) share:
// subscription filtering, backpressure, and the ping/pong liveness sweep.
import { describe, it, expect } from "vitest";
import { RoomsCore, type RoomSocket } from "../src/rooms-core.js";
import type { LiveEnvelope } from "../src/live.js";

class FakeSocket implements RoomSocket {
  sent: string[] = [];
  pings = 0;
  terminated = false;
  buffered = 0;
  refuse = false;
  send(text: string): boolean {
    if (this.refuse) return false;
    this.sent.push(text);
    return true;
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  ping(): void {
    this.pings++;
  }
  terminate(): void {
    this.terminated = true;
  }
}

const subscribe = (bbox: number[], callsign?: string) =>
  JSON.stringify({ type: "subscribe", bbox, ...(callsign ? { callsign } : {}) });
const station = (lat: number, lon: number, callsign = "OE8APR"): LiveEnvelope => ({
  station: { type: "station", callsign, lat, lon, lastSeen: 1 },
});
const rooms = () => new RoomsCore({ heartbeatMs: 0 });

describe("rooms-core", () => {
  it("delivers only what a member's subscription asks for", () => {
    const r = rooms();
    const a = new FakeSocket(),
      b = new FakeSocket(),
      none = new FakeSocket();
    r.join("global", a).message(subscribe([15, 47, 16, 48]));
    r.join("global", b).message(subscribe([0, 0, 1, 1], "OE8APR"));
    r.join("global", none);
    r.dispatch("global", [
      station(47.5, 15.5),
      {
        prompts: [
          { forCallsign: "OE8APR", prompt: { type: "near_cache", cacheId: 1, code: "AC-1", title: "t", distanceM: 5 } },
        ],
      },
    ]);
    expect(a.sent.map((s) => JSON.parse(s).type)).toEqual(["station"]);
    expect(b.sent.map((s) => JSON.parse(s).type)).toEqual(["near_cache"]);
    expect(none.sent).toEqual([]);
    expect(r.count("global")).toBe(3);
  });

  it("ignores malformed subscriptions", () => {
    const r = rooms();
    const a = new FakeSocket();
    const m = r.join("global", a);
    m.message("not json");
    m.message(JSON.stringify({ type: "subscribe", bbox: "all" }));
    r.dispatch("global", [station(47.5, 15.5)]);
    expect(a.sent).toEqual([]);
  });

  it("keeps regions apart", () => {
    const r = rooms();
    const a = new FakeSocket();
    r.join("eu", a).message(subscribe([-180, -90, 180, 90]));
    r.dispatch("global", [station(1, 1)]);
    expect(a.sent).toEqual([]);
    r.dispatch("eu", [station(1, 1)]);
    expect(a.sent).toHaveLength(1);
  });

  it("drops a member whose send queue is backing up", () => {
    const r = rooms();
    const slow = new FakeSocket();
    r.join("global", slow).message(subscribe([-180, -90, 180, 90]));
    slow.buffered = 2 << 20;
    r.dispatch("global", [station(1, 1)]);
    expect(slow.terminated).toBe(true);
    expect(slow.sent).toEqual([]);
    expect(r.count("global")).toBe(0);
  });

  it("stops sending to a member this dispatch once the runtime refuses a frame", () => {
    const r = rooms();
    const s = new FakeSocket();
    r.join("global", s).message(subscribe([-180, -90, 180, 90]));
    s.refuse = true;
    r.dispatch("global", [station(1, 1), station(2, 2)]);
    s.refuse = false;
    r.dispatch("global", [station(3, 3)]);
    expect(s.sent).toHaveLength(1); // the next dispatch sends again
    expect(r.count("global")).toBe(1);
  });

  it("reaps a member that never answers a ping, and keeps one that does", () => {
    const r = rooms();
    const dead = new FakeSocket(),
      live = new FakeSocket(),
      chatty = new FakeSocket();
    r.join("global", dead);
    const l = r.join("global", live);
    const c = r.join("global", chatty);
    r.sweep(); // marks every member, pings it
    expect([dead.pings, live.pings, chatty.pings]).toEqual([1, 1, 1]);
    l.pong();
    c.message(subscribe([0, 0, 1, 1])); // any frame proves the socket is reading
    r.sweep();
    expect(dead.terminated).toBe(true);
    expect(live.terminated || chatty.terminated).toBe(false);
    expect(r.count("global")).toBe(2);
  });

  it("forgets a member that leaves", () => {
    const r = rooms();
    const m = r.join("global", new FakeSocket());
    m.leave();
    m.leave();
    expect(r.count("global")).toBe(0);
  });
});
