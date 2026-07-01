import { describe, it, expect } from "vitest";
import { adminCalls } from "../src/admin.js";

const env = (ADMIN_CALLSIGNS?: string) => ({ ADMIN_CALLSIGNS } as any);

describe("instance-operator (sysop) identity", () => {
  it("parses a comma-separated ADMIN_CALLSIGNS into an uppercased set", () => {
    const s = adminCalls(env(" oe8apr , dl1abc "));
    expect([...s].sort()).toEqual(["DL1ABC", "OE8APR"]);
    expect(s.has("OE8APR")).toBe(true);
    expect(s.has("oe8apr" as string)).toBe(false);   // membership is case-sensitive; the gate uppercases the session call
  });

  it("is empty (no web sysop) when ADMIN_CALLSIGNS is absent or blank", () => {
    expect(adminCalls(env()).size).toBe(0);
    expect(adminCalls(env("")).size).toBe(0);
    expect(adminCalls(env("  ,  , ")).size).toBe(0);
  });
});
