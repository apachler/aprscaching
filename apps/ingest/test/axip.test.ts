// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrame, parseAddr } from "@aprscaching/ax25";
import { stripIpv4Header, axipToPacket, frameToAxip, parseAxipPeers } from "../src/axip.js";
import { appendAxipCrc, stripAxipCrc } from "../src/axudp.js";

/** A bare AX.25 UI/APRS frame (the AXIP IP-payload). */
function ax25Frame(src: string, dst: string, aprs: string): Uint8Array {
  return encodeFrame({
    dst: parseAddr(dst),
    src: parseAddr(src),
    command: true,
    type: "UI",
    pf: false,
    pid: 0xf0,
    info: new TextEncoder().encode(aprs),
  });
}
/** Prepend a minimal 20-byte IPv4 header (version 4, IHL 5, protocol 93) — what a raw proto-93 socket sees. */
function ipv4Proto93(payload: Uint8Array, ihlWords = 5): Uint8Array {
  const hdr = new Uint8Array(ihlWords * 4);
  hdr[0] = 0x40 | (ihlWords & 0x0f); // version 4 + IHL
  hdr[9] = 93; // protocol = AX.25
  const out = new Uint8Array(hdr.length + payload.length);
  out.set(hdr, 0);
  out.set(payload, hdr.length);
  return out;
}

describe("AXIP ingest — IP proto-93 encapsulation", () => {
  it("strips a 20-byte IPv4 header to expose the AX.25 payload", () => {
    const frame = ax25Frame("OE8APR-9", "APRS", "!4703.00N/01526.00E>x");
    const stripped = stripIpv4Header(ipv4Proto93(frame))!;
    expect(Array.from(stripped)).toEqual(Array.from(frame));
  });

  it("honours a variable IHL (header with options)", () => {
    const frame = ax25Frame("DL1ABC", "APRS", ">opts");
    const stripped = stripIpv4Header(ipv4Proto93(frame, 6))!; // IHL 6 = 24-byte header
    expect(Array.from(stripped)).toEqual(Array.from(frame));
  });

  it("rejects non-IPv4 / runt datagrams", () => {
    expect(stripIpv4Header(new Uint8Array(10))).toBeNull(); // too short
    expect(stripIpv4Header(new Uint8Array(20).fill(0x60))).toBeNull(); // version 6
  });

  it("decodes an AXIP datagram (with IP header) into a Tier-C Packet — never first-party attested", () => {
    const p = axipToPacket(ipv4Proto93(ax25Frame("OE8APR-9", "APRS", "!4703.00N/01526.00E>x")), 1000)!;
    expect(p.src).toBe("OE8APR-9");
    expect(p.payload).toBe("!4703.00N/01526.00E>x");
    expect(p.heardVia).toBe("aprs_is"); // → provenance firstPartyAttested = false
    expect(p.port).toBe("axip");
    expect(p.ts).toBe(1000);
  });

  it("falls back to a bare frame when a stack delivers the payload without an IP header", () => {
    const bare = ax25Frame("DL1ABC", "APRS", ">bare");
    const p = axipToPacket(bare, 1000)!;
    expect(p.src).toBe("DL1ABC");
    expect(p.port).toBe("axip");
  });

  it("decodes a trailered AXIP datagram — IP header + frame + RFC 1226 CRC (the JNOS/BPQ wire)", () => {
    const frame = ax25Frame("GB7BPQ-7", "APRS", ">via axip");
    const p = axipToPacket(ipv4Proto93(appendAxipCrc(frame)), 1000)!;
    expect(p.src).toBe("GB7BPQ-7");
    expect(p.payload).toBe(">via axip");
    expect(p.port).toBe("axip");
  });

  it("decodes a trailered payload delivered without an IP header", () => {
    const p = axipToPacket(appendAxipCrc(ax25Frame("DL1ABC", "APRS", ">trailered bare")), 1000)!;
    expect(p.src).toBe("DL1ABC");
    expect(p.payload).toBe(">trailered bare");
  });

  it("returns null for an undecodable datagram", () => {
    expect(axipToPacket(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("TX: frameToAxip emits frame + CRC trailer (kernel adds the IP header) and round-trips", () => {
    const f = {
      dst: parseAddr("OE8XBM-7"),
      src: parseAddr("OE8APR-9"),
      command: true,
      type: "UI" as const,
      pf: false,
      pid: 0xf0,
      info: new TextEncoder().encode("axip-tx"),
    };
    const payload = frameToAxip(f);
    // egress carries no IP header (raw proto-93 socket lets the kernel build it) but does carry the
    // RFC 1226 CRC trailer — a peer validates + strips it, our own RX does the same…
    expect(decodeFrame(stripAxipCrc(payload))!.src).toEqual(f.src);
    // …and lands it Tier C on the axip port.
    const p = axipToPacket(payload, 1000)!;
    expect(p.payload).toBe("axip-tx");
    expect(p.port).toBe("axip");
  });

  it("parses AXIP peers (host only — no port, unlike AXUDP)", () => {
    expect(parseAxipPeers("db0abc.ampr.org, 44.9.9.9")).toEqual([{ host: "db0abc.ampr.org" }, { host: "44.9.9.9" }]);
  });
});
