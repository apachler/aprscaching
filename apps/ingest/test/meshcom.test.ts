// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import dgram from "node:dgram";
import type { Packet } from "@aprscaching/shared";
import { MeshcomListener, meshcomToPacket } from "../src/meshcom.js";

const NODE = "192.168.1.50";
const enc = (o: object) => new TextEncoder().encode(JSON.stringify(o));
const pos = (over: object = {}) =>
  enc({
    src_type: "lora",
    type: "pos",
    src: "OE8APR-12,OE8XBM-1",
    lat: 46.6247,
    lat_dir: "N",
    long: 14.3053,
    long_dir: "E",
    aprs_symbol: "#",
    aprs_symbol_group: "/",
    msg_id: "0A1B2C3D",
    rssi: -101,
    snr: 7,
    ...over,
  });
const msg = (over: object = {}) =>
  enc({ src_type: "lora", type: "msg", src: "DH1FR-1", dst: "OE8APR-1", msg: "hi{12", msg_id: "11223344", ...over });

describe("MeshCom ingest normalise", () => {
  it("forwards a position on the meshcom port with the relay path and a pre-parsed fix", () => {
    const p = meshcomToPacket(pos(), 1000)!;
    expect(p).toMatchObject({ src: "OE8APR-12", path: ["OE8XBM-1"], kind: "position", port: "meshcom", ts: 1000 });
    expect((p.parsed as { lat: number }).lat).toBeCloseTo(46.6247, 4);
  });

  it("lands every frame at Tier C, whatever src_type says (transport != trust)", () => {
    for (const src_type of ["lora", "udp", "node"]) {
      const p = meshcomToPacket(pos({ src_type }))!;
      // heardVia:aprs_is, no IGate and no qAR → the gateway's provenance gives firstPartyAttested = false.
      expect(p.heardVia).toBe("aprs_is");
      expect(p.igateCall).toBeUndefined();
      expect(p.path.some((h) => /^qA[RO]$/i.test(h))).toBe(false);
    }
  });

  it("forwards a direct message as an APRS message", () => {
    const p = meshcomToPacket(msg())!;
    expect(p.kind).toBe("message");
    expect(p.payload).toBe(":OE8APR-1 :hi{12");
  });

  it("returns null for a datagram that is not MeshCom output", () => {
    expect(meshcomToPacket("garbage")).toBeNull();
  });
});

describe("MeshcomListener", () => {
  const listener = () => {
    const out: Packet[] = [];
    return { l: new MeshcomListener({ node: NODE, port: 0 }, (p) => out.push(p)), out };
  };

  it("drops datagrams that do not come from the configured node", () => {
    const { l, out } = listener();
    expect(l.receive(pos(), "192.168.1.66")).toBeNull();
    expect(out).toHaveLength(0);
    expect(l.receive(pos(), NODE)).not.toBeNull();
    expect(out).toHaveLength(1);
  });

  it("forwards one copy of a frame heard over LoRa and again from the server", () => {
    const { l, out } = listener();
    l.receive(pos({ src_type: "lora" }), NODE, 0);
    l.receive(pos({ src_type: "udp" }), NODE, 5_000);
    expect(out).toHaveLength(1);
    l.receive(pos({ msg_id: "0A1B2C3E" }), NODE, 6_000); // the next beacon carries a new id
    expect(out).toHaveLength(2);
  });

  it("forwards a repeated frame id again once the dedupe window has passed", () => {
    const { l, out } = listener();
    l.receive(msg(), NODE, 0);
    l.receive(msg(), NODE, 11 * 60_000);
    expect(out).toHaveLength(2);
  });

  it("receives over a real UDP socket", async () => {
    const out: Packet[] = [];
    const l = new MeshcomListener({ node: "127.0.0.1", port: 0, bind: "127.0.0.1" }, (p) => out.push(p));
    l.start();
    const sock = (l as unknown as { sock: dgram.Socket }).sock;
    await new Promise<void>((r) => sock.once("listening", () => r()));
    const { port } = sock.address();
    const tx = dgram.createSocket("udp4");
    await new Promise<void>((r) => tx.send(msg(), port, "127.0.0.1", () => r()));
    for (let i = 0; i < 50 && out.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    tx.close();
    l.stop();
    expect(out).toHaveLength(1);
    expect(out[0]!.src).toBe("DH1FR-1");
  });
});
