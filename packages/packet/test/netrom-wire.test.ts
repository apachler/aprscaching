import { describe, it, expect } from "vitest";
import {
  encodeNetrom, decodeNetrom, encodeNodesBroadcast, decodeNodesBroadcast, combineQuality,
  NrOp, NR_MORE, NR_CHOKE, NETROM_PID,
} from "../src/netrom-wire.js";

describe("NET/ROM wire codec (docs/29 F2)", () => {
  it("round-trips an inter-node packet (15-byte net + 5-byte transport header)", () => {
    const pkt = {
      net: { origin: { call: "OE8XBM", ssid: 7 }, dest: { call: "DB0XYZ", ssid: 0 }, ttl: 25 },
      tp: { opcode: NrOp.Info, flags: NR_MORE, circuitIndex: 3, circuitId: 42, txSeq: 5, rxSeq: 6 },
      info: new TextEncoder().encode("hello node"),
    };
    const bytes = encodeNetrom(pkt);
    expect(bytes.length).toBe(20 + pkt.info.length);
    const back = decodeNetrom(bytes)!;
    expect(back.net.origin).toEqual({ call: "OE8XBM", ssid: 7 });
    expect(back.net.dest).toEqual({ call: "DB0XYZ", ssid: 0 });
    expect(back.net.ttl).toBe(25);
    expect(back.tp).toEqual({ opcode: NrOp.Info, flags: NR_MORE, circuitIndex: 3, circuitId: 42, txSeq: 5, rxSeq: 6 });
    expect(new TextDecoder().decode(back.info)).toBe("hello node");
  });

  it("keeps opcode and flag bits separate in the opcode&flags byte", () => {
    const b = encodeNetrom({
      net: { origin: { call: "A", ssid: 0 }, dest: { call: "B", ssid: 0 }, ttl: 1 },
      tp: { opcode: NrOp.InfoAck, flags: NR_CHOKE, circuitIndex: 0, circuitId: 0, txSeq: 0, rxSeq: 9 },
      info: new Uint8Array(),
    });
    expect(b[19]).toBe(NR_CHOKE | NrOp.InfoAck); // 0x80 | 6
    const back = decodeNetrom(b)!;
    expect(back.tp.opcode).toBe(NrOp.InfoAck);
    expect(back.tp.flags).toBe(NR_CHOKE);
  });

  it("decodes nothing from a truncated buffer", () => {
    expect(decodeNetrom(new Uint8Array(19))).toBeNull();
  });

  it("round-trips a NODES broadcast and chunks to ≤11 destinations per frame", () => {
    const dests = Array.from({ length: 25 }, (_, i) => ({
      dest: { call: `DEST${i % 10}`, ssid: i % 16 }, alias: `AL${i}`,
      neighbor: { call: "NB0ABC", ssid: 1 }, quality: 200 - i,
    }));
    const frames = encodeNodesBroadcast("OE8HUB", dests);
    expect(frames.length).toBe(3); // 11 + 11 + 3
    expect(frames[0]!.length).toBe(7 + 11 * 21);
    // reassemble
    const all = frames.flatMap((f) => decodeNodesBroadcast(f)!.dests);
    expect(all.length).toBe(25);
    expect(decodeNodesBroadcast(frames[0]!)!.senderAlias).toBe("OE8HUB");
    expect(all[0]).toEqual({ dest: { call: "DEST0", ssid: 0 }, alias: "AL0", neighbor: { call: "NB0ABC", ssid: 1 }, quality: 200 });
    expect(all[24]!.quality).toBe(176);
  });

  it("emits an empty (destinations-less) NODES frame and rejects a bad signature", () => {
    const [f] = encodeNodesBroadcast("OE8HUB", []);
    expect(f!.length).toBe(7);
    expect(decodeNodesBroadcast(f!)!.dests).toEqual([]);
    const bad = new Uint8Array(7); bad[0] = 0x00;
    expect(decodeNodesBroadcast(bad)).toBeNull();
  });

  it("combines route + path quality per the spec formula", () => {
    // (192 * 192 + 128) / 256 = 144
    expect(combineQuality(192, 192)).toBe(144);
    expect(combineQuality(255, 255)).toBe(254);
    expect(combineQuality(0, 200)).toBe(0);
  });

  it("exposes the amateur NET/ROM PID", () => {
    expect(NETROM_PID).toBe(0xcf);
  });
});
