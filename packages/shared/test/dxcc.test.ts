// SPDX-License-Identifier: MIT
// DXCC entities from AD1C's country file: the list, a callsign's entity by its longest prefix, and the country
// field's validation.
import { describe, expect, it } from "vitest";
import { DXCC_ENTITIES, DxccPrefix, dxccEntity, dxccOfCall } from "../src/index.js";

describe("DXCC entities", () => {
  it("lists the entities by name, without the Worked All Europe extras", () => {
    expect(DXCC_ENTITIES.length).toBeGreaterThan(330);
    expect(dxccEntity("oe")).toMatchObject({ prefix: "OE", name: "Austria", continent: "EU" });
    expect(DXCC_ENTITIES.some((e) => e.prefix.startsWith("*"))).toBe(false);
    const names = DXCC_ENTITIES.map((e) => e.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it("finds a callsign's entity by its longest prefix", () => {
    expect(dxccOfCall("OE8APR")?.prefix).toBe("OE");
    expect(dxccOfCall("oe8apr-7")?.prefix).toBe("OE");
    expect(dxccOfCall("DK1ABC")?.prefix).toBe("DL");
    expect(dxccOfCall("W1AW")?.prefix).toBe("K");
    expect(dxccOfCall("KH6XYZ")?.prefix).toBe("KH6");
    expect(dxccOfCall("9A1AA")?.prefix).toBe("9A");
  });

  it("reads the country operated from in a portable call, and ignores operating suffixes", () => {
    expect(dxccOfCall("DL/OE8APR")?.prefix).toBe("DL");
    expect(dxccOfCall("OE8APR/P")?.prefix).toBe("OE");
    expect(dxccOfCall("OE8APR/HB9")?.prefix).toBe("HB");
    expect(dxccOfCall("")).toBeUndefined();
  });

  it("accepts only a DXCC primary prefix as a cache's country", () => {
    expect(DxccPrefix.parse(" oe ")).toBe("OE");
    expect(DxccPrefix.parse("3D2/C")).toBe("3D2/c"); // Conway Reef keeps the file's spelling
    expect(dxccEntity("3d2/c")?.name).toBe("Conway Reef");
    expect(DxccPrefix.safeParse("AT").success).toBe(false);
    expect(DxccPrefix.safeParse("Austria").success).toBe(false);
  });
});
