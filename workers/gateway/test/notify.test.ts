import { describe, it, expect } from "vitest";
import { composeDigest, b64urlToBytes, bytesToB64url } from "../src/notify.js";

describe("notify — email digest + helpers (ADR-4b)", () => {
  it("composeDigest summarises alerts, pluralising correctly", () => {
    const one = composeDigest([{ callsign: "OE8APR", kind: "near_cache", detail: "OE8APR heard near AC-0001 — Schlossberg", ts: 1 }]);
    expect(one.subject).toBe("aprscaching — 1 new watchlist alert");
    expect(one.text).toContain("• OE8APR heard near AC-0001 — Schlossberg");

    const many = composeDigest([
      { callsign: "A", kind: "heard", ts: 1 },
      { callsign: "B", kind: "near_cache", detail: "B near X", ts: 2 },
    ]);
    expect(many.subject).toBe("aprscaching — 2 new watchlist alerts");
    expect(many.text).toContain("• A heard");      // falls back to callsign+kind when no detail
    expect(many.text).toContain("• B near X");
  });

  it("base64url round-trips bytes (and is URL-safe, unpadded)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66]);
    const s = bytesToB64url(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect([...b64urlToBytes(s)]).toEqual([...bytes]);
  });
});
