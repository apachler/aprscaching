// SPDX-License-Identifier: AGPL-3.0-or-later
// The deflateDict1 codec: roundtrip fidelity, corruption safety, and the reason the dictionary
// exists — on a realistic small sync page the preset vocabulary must beat plain deflate.
import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { compressDict1, decompressDict1 } from "../src/fedcompress.js";
import { cborEncode, toCborValue, type CborValue } from "@aprscaching/shared";

/** A realistic compact-tier payload: one CBOR page of cache-record bodies. */
function samplePage(records: number): Uint8Array {
  const items: CborValue[] = [];
  for (let i = 0; i < records; i++) {
    items.push(
      toCborValue({
        code: `ACS-${100 + i}`,
        title: `Schlossberg stage ${i}`,
        ownerCall: "OE8APR",
        type: "traditional",
        status: "active",
        difficultyX10: 15,
        terrainX10: 20,
        latE7: 470832156 + i * 1000,
        lonE7: 154232890 + i * 1000,
        source: "native",
        createdAt: 1700000000 + i,
        updatedAt: 1700005000 + i,
      }),
    );
  }
  return cborEncode(items);
}

describe("deflateDict1 codec", () => {
  it("round-trips payloads byte-exactly", () => {
    for (const n of [1, 5, 40]) {
      const page = samplePage(n);
      const packed = compressDict1(page);
      expect([...decompressDict1(packed)!]).toEqual([...page]);
    }
  });

  it("rejects corrupt input and never throws", () => {
    const packed = compressDict1(samplePage(3));
    packed[2] ^= 0xff;
    expect(decompressDict1(packed)).toBeNull();
    expect(decompressDict1(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decompressDict1(new Uint8Array(0))).toBeNull();
  });

  it("the preset dictionary beats plain deflate on a small page (the whole point)", () => {
    const page = samplePage(2); // small pages are the compact-tier norm — too short to self-train
    const withDict = compressDict1(page).length;
    const without = deflateSync(page, { level: 9 }).length;
    expect(withDict).toBeLessThan(without);
  });
});
