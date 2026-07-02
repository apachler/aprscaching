import { describe, it, expect } from "vitest";
import { parseRelayQuery, answerRelayQuery } from "../src/relay.js";

describe("federation rendezvous relay — pure core (docs/15 T2.3 path 2)", () => {
  it("parses a valid feed query and rejects unknown/malformed kinds", () => {
    expect(parseRelayQuery({ kind: "feed", params: { feed: "caches", since: 5 } })).toEqual({ kind: "feed", params: { feed: "caches", since: 5 } });
    expect(parseRelayQuery({ kind: "corroborate" })).toEqual({ kind: "corroborate", params: {} });
    expect(parseRelayQuery({ kind: "bogus" })).toBeNull();
    expect(parseRelayQuery(null)).toBeNull();
    expect(parseRelayQuery({ kind: "feed", params: 7 })).toBeNull();
  });

  it("dispatches a feed query to the injected feed source", async () => {
    const page = { feed: "caches", since: 0, items: [{ type: "cache", id: "x" }], nextCursor: 9, complete: true };
    const r = await answerRelayQuery({ kind: "feed", params: { feed: "caches" } }, { feed: async () => page });
    expect(r).toEqual({ ok: true, kind: "feed", data: page });
  });

  it("returns ok:false (not a throw) when the kind's source is absent", async () => {
    const r = await answerRelayQuery({ kind: "corroborate", params: {} }, { feed: async () => ({}) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/corroborate not supported/);
  });

  it("captures a source error as a clean failed result", async () => {
    const r = await answerRelayQuery({ kind: "feed", params: { feed: "nope" } }, { feed: async () => { throw new Error("unknown feed 'nope'"); } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unknown feed 'nope'");
  });
});
