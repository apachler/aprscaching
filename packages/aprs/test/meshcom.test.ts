// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseMeshcomUdp, decodeAprs, MESHCOM_MAX_DATAGRAM } from "../src/index.js";

// Datagrams shaped exactly as the MeshCom firmware's sendExtern() serialises them.
const POS = {
  src_type: "lora",
  type: "pos",
  src: "9V1LH-1,OE1KBC-12",
  msg: "",
  lat: 1.3773,
  lat_dir: "N",
  long: 103.942,
  long_dir: "E",
  aprs_symbol: "#",
  aprs_symbol_group: "/",
  hw_id: 4,
  msg_id: "AE48D54D",
  alt: 161,
  batt: 5,
  firmware: 17,
  fw_sub: "p",
  rssi: -95,
  snr: 12,
};
const MSG = {
  src_type: "lora",
  type: "msg",
  src: "DH1FR-1",
  dst: "DH1FR-2",
  msg: "Hello{034",
  msg_id: "5DFC7187",
  firmware: 35,
  fw_sub: "p",
  rssi: -95,
  snr: 12,
};
const j = (o: object) => JSON.stringify(o);
const decode = (f: { src: string; dst?: string; payload: string }) =>
  decodeAprs({ src: f.src, dst: f.dst ?? "", path: [], payload: f.payload, raw: "" }) as any;

describe("meshcom — external UDP positions", () => {
  it("normalises a pos datagram to an APRS position the decoder reads back", () => {
    const f = parseMeshcomUdp(j(POS))!;
    expect(f.kind).toBe("position");
    expect(f.srcType).toBe("lora");
    expect(f.src).toBe("9V1LH-1");
    expect(f.relays).toEqual(["OE1KBC-12"]);
    expect(f.msgId).toBe("AE48D54D");
    expect(f).toMatchObject({ rssi: -95, snr: 12 });
    const d = decode(f);
    expect(d.kind).toBe("position");
    expect(d.lat).toBeCloseTo(1.3773, 3);
    expect(d.lon).toBeCloseTo(103.942, 3);
    expect(d.symbol).toMatchObject({ table: "/", code: "#" });
  });

  it("applies the hemisphere from lat_dir / long_dir", () => {
    const f = parseMeshcomUdp(j({ ...POS, lat: 33.8688, lat_dir: "S", long: 70.5, long_dir: "W" }))!;
    expect(f.lat).toBeCloseTo(-33.8688, 4);
    expect(f.lon).toBeCloseTo(-70.5, 4);
    const d = decode(f);
    expect(d.lat).toBeCloseTo(-33.8688, 3);
    expect(d.lon).toBeCloseTo(-70.5, 3);
  });

  it("takes the first character of a doubled backslash symbol table", () => {
    // The firmware doubles `\` before serialising, so the JSON string holds two backslashes.
    const f = parseMeshcomUdp(j({ ...POS, aprs_symbol_group: "\\\\", aprs_symbol: "n" }))!;
    expect(decode(f).symbol).toMatchObject({ table: "\\", code: "n" });
  });

  it("carries a 60.00' rounding overflow into the degrees", () => {
    const f = parseMeshcomUdp(j({ ...POS, lat: 47.99999, long: 15.99999 }))!;
    expect(f.payload.startsWith("!4800.00N/01600.00E")).toBe(true);
  });

  it("drops a node without a fix and out-of-range or malformed coordinates", () => {
    expect(parseMeshcomUdp(j({ ...POS, lat: 0, long: 0 }))).toBeNull();
    expect(parseMeshcomUdp(j({ ...POS, lat: 91 }))).toBeNull();
    expect(parseMeshcomUdp(j({ ...POS, long: -5 }))).toBeNull();
    expect(parseMeshcomUdp(j({ ...POS, lat_dir: "X" }))).toBeNull();
    expect(parseMeshcomUdp(j({ ...POS, lat: "48.2" }))).toBeNull();
  });
});

describe("meshcom — external UDP messages", () => {
  it("maps a direct message to an APRS message, keeping the {msgNo", () => {
    const f = parseMeshcomUdp(j(MSG))!;
    expect(f.kind).toBe("message");
    expect(f.dst).toBe("DH1FR-2");
    const d = decode(f);
    expect(d.kind).toBe("message");
    expect(d.addressee).toBe("DH1FR-2");
    expect(d.text).toBe("Hello");
    expect(d.msgNo).toBe("034");
  });

  it("keeps group and broadcast text out of the message log", () => {
    for (const dst of ["262", "9", "*"]) {
      const f = parseMeshcomUdp(j({ ...MSG, dst, msg: "CQ group" }))!;
      expect(f.kind).toBe("group");
      expect(f.dst).toBe(dst);
      expect(decode(f).kind).toBe("other");
    }
  });

  it("collapses control characters so a payload stays one line", () => {
    const f = parseMeshcomUdp(j({ ...MSG, msg: "line1\r\nline2" }))!;
    expect(decode(f).text).toBe("line1 line2");
  });

  it("drops empty text and unknown destinations", () => {
    expect(parseMeshcomUdp(j({ ...MSG, msg: "  " }))).toBeNull();
    expect(parseMeshcomUdp(j({ ...MSG, dst: "not a call" }))).toBeNull();
  });
});

describe("meshcom — hostile or foreign input", () => {
  it("rejects non-JSON, arrays, unknown types and unknown src_type", () => {
    expect(parseMeshcomUdp("not json")).toBeNull();
    expect(parseMeshcomUdp("[]")).toBeNull();
    expect(parseMeshcomUdp(j({ ...POS, type: "tele" }))).toBeNull();
    expect(parseMeshcomUdp(j({ ...POS, src_type: "mqtt" }))).toBeNull();
    expect(parseMeshcomUdp(j({ type: "hb", seq: 1, ms: 500 }))).toBeNull();
  });

  it("rejects source paths that are not amateur callsigns", () => {
    expect(parseMeshcomUdp(j({ ...MSG, src: "HOME" }))).toBeNull(); // firmware-internal source
    expect(parseMeshcomUdp(j({ ...MSG, src: "DH1FR-1,<script>" }))).toBeNull();
    expect(parseMeshcomUdp(j({ ...MSG, src: "" }))).toBeNull();
    expect(parseMeshcomUdp(j({ ...MSG, src: "TOOLONGCALL1" }))).toBeNull();
  });

  it("accepts a MeshCom SSID beyond the AX.25 0–15 range", () => {
    expect(parseMeshcomUdp(j({ ...MSG, src: "OE0XXX-99" }))?.src).toBe("OE0XXX-99");
  });

  it("refuses an oversized datagram before parsing it", () => {
    const big = j({ ...MSG, msg: "x".repeat(MESHCOM_MAX_DATAGRAM) });
    expect(parseMeshcomUdp(big)).toBeNull();
  });

  it("decodes a byte buffer the same as a string", () => {
    const f = parseMeshcomUdp(new TextEncoder().encode(j(MSG)));
    expect(f?.src).toBe("DH1FR-1");
  });
});
