// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { Packet, IngestBatch, PACKET_LINE_MAX } from "../src/index.js";

const base = {
  src: "OE8APR-9",
  dst: "APRS",
  path: ["WIDE1-1", "qAR", "OE8XXX-10"],
  payload: "!4704.41N/01526.27E>",
  ts: 1,
};

describe("ingested packet field ceilings", () => {
  it("accepts real-world packets: APRS-IS, MeshCom calls and paths, an IPv6 q-construct, a full line", () => {
    expect(Packet.safeParse(base).success).toBe(true);
    expect(Packet.safeParse({ ...base, src: "OE1KBC-AB", dst: "*", path: ["OE1KBC-AB", "OE3XYZ-12"] }).success).toBe(
      true,
    );
    expect(
      Packet.safeParse({ ...base, path: ["TCPIP*", "qAI", "20010DB8000000000000000000000001", "T2CZECH"] }).success,
    ).toBe(true);
    const payload = ">" + "x".repeat(PACKET_LINE_MAX - 1);
    expect(Packet.safeParse({ ...base, payload, raw: payload }).success).toBe(true);
  });

  it("refuses a field past its ceiling", () => {
    for (const over of [
      { src: "X".repeat(17) },
      { dst: "X".repeat(17) },
      { path: ["X".repeat(33)] },
      { path: Array.from({ length: 33 }, () => "WIDE1-1") },
      { payload: "x".repeat(PACKET_LINE_MAX + 1) },
      { raw: "x".repeat(PACKET_LINE_MAX + 1) },
      { igateCall: "X".repeat(17) },
      { port: "p".repeat(65) },
    ])
      expect(Packet.safeParse({ ...base, ...over }).success, Object.keys(over)[0]).toBe(false);
    expect(IngestBatch.safeParse({ packets: [base, { ...base, payload: "x".repeat(600) }] }).success).toBe(false);
  });
});
