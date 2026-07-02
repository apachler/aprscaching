import { describe, it, expect } from "vitest";
import { encodeFrame, parseAddr } from "@aprsweb/ax25";
import { axudpToPacket, parseAxudpPeers } from "../src/axudp.js";

/** A bare AX.25 UI/APRS frame — exactly what an AXUDP datagram (BPQ mesh, UDP 10093) carries. */
function axudpDatagram(src: string, dst: string, aprs: string): Uint8Array {
  return encodeFrame({
    dst: parseAddr(dst), src: parseAddr(src), command: true, type: "UI", pf: false,
    pid: 0xf0, info: new TextEncoder().encode(aprs),
  });
}

describe("AXUDP ingest normalize (docs/22 reserved seam)", () => {
  it("decodes a tunnelled AX.25 frame into a Packet", () => {
    const p = axudpToPacket(axudpDatagram("OE8APR-9", "APRS", "!4703.00N/01526.00E>test"), 1000)!;
    expect(p).not.toBeNull();
    expect(p.src).toBe("OE8APR-9");
    expect(p.payload).toBe("!4703.00N/01526.00E>test");
    expect(p.ts).toBe(1000);
  });

  it("lands the frame at Tier C and can NEVER be first-party attested (transport != trust)", () => {
    const p = axudpToPacket(axudpDatagram("DL1ABC", "APRS", ">just a status"), 1000)!;
    // heardVia:aprs_is + port:axudp + no qAR in the path → the gateway's provenance derivation gives
    // firstPartyAttested = false. This is the invariant the reserved seam must never regress.
    expect(p.heardVia).toBe("aprs_is");
    expect(p.port).toBe("axudp");
    expect((p.path ?? []).some((h) => /^qAR$/i.test(h))).toBe(false);
  });

  it("returns null for an undecodable datagram", () => {
    expect(axudpToPacket(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("parses a peer spec, defaulting to the AXUDP port 10093", () => {
    expect(parseAxudpPeers("db0xyz.example:10093, 44.1.2.3")).toEqual([
      { host: "db0xyz.example", port: 10093 },
      { host: "44.1.2.3", port: 10093 },
    ]);
  });
});
