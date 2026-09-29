// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  decodeMeshcom,
  parseMeshcomDatagram,
  meshcomToAprs,
  meshcomTransportHint,
  MeshcomDedup,
  encodeMeshcomText,
  decodeAprs,
  MESHCOM_MAX_DATAGRAM,
  type MeshcomEvent,
} from "../src/index.js";
import { runMeshcomConformance } from "./conformance/meshcom.js";
import { loadMeshcomFixtures } from "./fixtures/meshcom/load.mjs";

const fixtures = loadMeshcomFixtures();

const j = (o: object) => JSON.stringify(o);
const MSG = {
  src_type: "lora",
  type: "msg",
  src: "DH1FR-1",
  dst: "OE8APR-12",
  msg: "hi",
  msg_id: "11223344",
  rssi: -90,
  snr: 5,
};
const ok = (r: ReturnType<typeof decodeMeshcom>): MeshcomEvent => {
  if (!r.ok) throw new Error(r.reason);
  return r.event;
};

describe("meshcom golden fixtures", () => {
  it("every fixture decodes to its expected result", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(26);
    expect(runMeshcomConformance(fixtures).failures).toEqual([]);
  });
});

describe("meshcom hemisphere", () => {
  it("S/W give negative coordinates and N/E positive ones, and the APRS frame keeps the sign", () => {
    const base = { src_type: "lora", type: "pos", src: "CE3ABC-1", msg_id: "1" };
    for (const [ns, ew, sLat, sLon] of [
      ["N", "E", 1, 1],
      ["S", "E", -1, 1],
      ["N", "W", 1, -1],
      ["S", "W", -1, -1],
    ] as const) {
      const e = ok(decodeMeshcom(j({ ...base, lat: 33.4489, lat_dir: ns, long: 70.6693, long_dir: ew })));
      if (e.type !== "pos") throw new Error("not a position");
      expect(Math.sign(e.lat)).toBe(sLat);
      expect(Math.sign(e.lon)).toBe(sLon);
      const a = meshcomToAprs(e)!;
      const d = decodeAprs({ src: a.src, dst: "APRS", path: [], payload: a.payload, raw: "" }) as {
        lat: number;
        lon: number;
      };
      expect(d.lat).toBeCloseTo(e.lat, 3);
      expect(d.lon).toBeCloseTo(e.lon, 3);
    }
  });
});

describe("meshcom trust hint (no internet or relayed frame can name a gate)", () => {
  const hint = (o: object, receiver = "OE8APR-12") =>
    meshcomTransportHint(ok(decodeMeshcom(j(o), { receiverCalls: [receiver] })).provenance, receiver);

  it("a direct LoRa hearing names the receiving node as its gate", () => {
    expect(hint(MSG)).toEqual({ heardVia: "rf", igateCall: "OE8APR-12" });
  });
  it("a server-relayed frame is internet-sourced with no gate", () => {
    expect(hint({ ...MSG, src_type: "udp" })).toEqual({ heardVia: "aprs_is" });
  });
  it("the node's own traffic is internet-sourced with no gate", () => {
    expect(hint({ ...MSG, src_type: "node" })).toEqual({ heardVia: "aprs_is" });
  });
  it("a relayed LoRa frame is RF-observed but names no gate", () => {
    expect(hint({ ...MSG, src: "DH1FR-1,OE1XOR-12" })).toEqual({ heardVia: "rf" });
  });
  it("the node's own back-pressure notice is not RF even though src_type says lora", () => {
    expect(hint({ ...MSG, src: "OE8APR-12", rssi: 0, snr: 0, msg: "QRT NOT SENT - hi" })).toEqual({
      heardVia: "aprs_is",
    });
  });
  it("without a configured receiver call a direct hearing names no gate", () => {
    expect(meshcomTransportHint(ok(decodeMeshcom(j(MSG))).provenance)).toEqual({ heardVia: "rf" });
  });
});

describe("meshcom APRS mapping", () => {
  it("direct messages become APRS messages; group and broadcast text stays out of the message log", () => {
    const dm = meshcomToAprs(ok(decodeMeshcom(j({ ...MSG, msg: "Hello{034" }))))!;
    const d = decodeAprs({ src: dm.src, dst: "APRS", path: [], payload: dm.payload, raw: "" }) as {
      kind: string;
      msgNo?: string;
    };
    expect(d.kind).toBe("message");
    expect(d.msgNo).toBe("034");
    for (const dst of ["262", "9", "*"]) {
      const g = meshcomToAprs(ok(decodeMeshcom(j({ ...MSG, dst }))))!;
      expect(decodeAprs({ src: g.src, dst: "APRS", path: [], payload: g.payload, raw: "" }).kind).toBe("other");
    }
  });
  it("telemetry has no APRS mapping", () => {
    expect(
      meshcomToAprs(ok(decodeMeshcom(j({ src_type: "node", type: "tele", src: "OE8APR-12", temp1: 1 })))),
    ).toBeNull();
  });
});

describe("meshcom parser robustness (never throws, never unbounded)", () => {
  // Deterministic PRNG so a failure reproduces.
  let seed = 0x12345678;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;

  it("survives random bytes", () => {
    for (let i = 0; i < 5000; i++) {
      const b = Uint8Array.from({ length: Math.floor(rnd() * 300) }, () => Math.floor(rnd() * 256));
      expect(() => decodeMeshcom(b)).not.toThrow();
    }
  });
  it("survives every truncation of a valid datagram", () => {
    const full = j({ ...MSG, src: "DH1FR-1,OE1XOR-12" });
    for (let n = 0; n <= full.length; n++) expect(() => decodeMeshcom(full.slice(0, n))).not.toThrow();
  });
  it("survives deep nesting within the size cap", () => {
    const deep = "[".repeat(1000) + "]".repeat(1000);
    expect(decodeMeshcom(deep)).toEqual({ ok: false, reason: "not-object" });
    const deepField = `{"src_type":"lora","type":"msg","src":"DH1FR-1","dst":"OE8APR-12","msg":${"[".repeat(900)}${"]".repeat(900)}}`;
    expect(() => decodeMeshcom(deepField)).not.toThrow();
  });
  it("refuses an oversized datagram before decoding it", () => {
    const big = new Uint8Array(MESHCOM_MAX_DATAGRAM + 1).fill(0x20);
    expect(parseMeshcomDatagram(big)).toEqual({ ok: false, reason: "too-large" });
    expect(parseMeshcomDatagram(" ".repeat(MESHCOM_MAX_DATAGRAM + 1))).toEqual({ ok: false, reason: "too-large" });
  });
  it("rejects wrong field types with a reason instead of throwing", () => {
    expect(decodeMeshcom(j({ ...MSG, src: 42 }))).toEqual({ ok: false, reason: "bad-src" });
    expect(decodeMeshcom(j({ ...MSG, dst: null }))).toEqual({ ok: false, reason: "bad-dst" });
    expect(decodeMeshcom(j({ src_type: "lora", type: "pos", src: "DH1FR-1", lat: "48", long: 16 }))).toEqual({
      ok: false,
      reason: "bad-position",
    });
  });
});

describe("meshcom dedup", () => {
  const ev = (srcType: string, src: string, id: string) =>
    ok(decodeMeshcom(j({ ...MSG, src_type: srcType, src, msg_id: id })));

  it("a later RF sighting of a server-relayed frame upgrades it; weaker copies are duplicates", () => {
    const d = new MeshcomDedup();
    expect(d.offer(ev("udp", "DH1FR-1", "A1"), 0)).toBe("new");
    expect(d.offer(ev("lora", "DH1FR-1", "A1"), 1)).toBe("upgrade");
    expect(d.offer(ev("udp", "DH1FR-1", "A1"), 2)).toBe("duplicate");
    expect(d.offer(ev("lora", "DH1FR-1,OE1XOR-12", "A1"), 3)).toBe("duplicate");
  });
  it("a frame id counts as new again once the window has passed", () => {
    const d = new MeshcomDedup({ windowMs: 1000 });
    expect(d.offer(ev("lora", "DH1FR-1", "B1"), 0)).toBe("new");
    expect(d.offer(ev("lora", "DH1FR-1", "B1"), 1001)).toBe("new");
  });
  it("stays bounded in memory across 1M distinct frames", { timeout: 60_000 }, () => {
    const d = new MeshcomDedup({ max: 4096 });
    const e = ev("lora", "DH1FR-1", "0");
    for (let i = 0; i < 1_000_000; i++) {
      e.provenance.msgId = i.toString(16).toUpperCase();
      d.offer(e, i);
    }
    expect(d.size).toBeLessThanOrEqual(4096);
  });
});

describe("meshcom encoder", () => {
  it("measures the 150 limit in UTF-8 bytes and refuses groups and broadcast", () => {
    expect(encodeMeshcomText("OE8APR-12", "ä".repeat(75)).ok).toBe(true);
    expect(encodeMeshcomText("OE8APR-12", "ä".repeat(76))).toEqual({ ok: false, reason: "text-too-long" });
    expect(encodeMeshcomText("*", "hi")).toEqual({ ok: false, reason: "dst-not-allowed" });
    expect(encodeMeshcomText("262", "hi")).toEqual({ ok: false, reason: "dst-not-allowed" });
  });
  it("strips control characters, so a NUL can never reach the node", () => {
    const r = encodeMeshcomText("OE8APR-12", "a\u0000b");
    expect(r.ok && JSON.parse(r.datagram).msg).toBe("a b");
  });
});
