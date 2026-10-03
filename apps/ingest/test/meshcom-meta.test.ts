// SPDX-License-Identifier: AGPL-3.0-or-later
// The MeshCom metadata the ingest carries to the gateway for the map: how the node got each frame, the
// signal of a LoRa hearing, the sender's device. Display only; the transport hint that feeds trust is the
// same with or without it.
import { describe, it, expect } from "vitest";
import type { Packet } from "@aprscaching/shared";
import { MeshcomListener } from "../src/meshcom.js";

const NODE = "192.168.1.50";
const CALL = "OE8APR-12";
const enc = (o: object) => new TextEncoder().encode(JSON.stringify(o));
const pos = (over: object = {}) =>
  enc({
    src_type: "lora",
    type: "pos",
    src: "DH1FR-1",
    lat: 46.6247,
    lat_dir: "N",
    long: 14.3053,
    long_dir: "E",
    msg_id: "0A1B2C3D",
    rssi: -101,
    snr: 7,
    batt: 87,
    hw_id: 8,
    firmware: 4.35,
    fw_sub: "t",
    ...over,
  });

function receive(datagram: Uint8Array): Packet {
  const out: Packet[] = [];
  const l = new MeshcomListener({ nodes: [{ ip: NODE, call: CALL }] }, (p) => out.push(p), {
    log: () => {},
    warn: () => {},
    error: () => {},
  });
  l.receive(datagram, NODE, 1_000_000);
  expect(out).toHaveLength(1);
  return out[0]!;
}
const meta = (p: Packet) => (p.parsed as { meshcom?: Record<string, unknown> }).meshcom;

describe("MeshCom metadata on the packet", () => {
  it("a direct LoRa hearing: signal, device, receiver", () => {
    const p = receive(pos());
    expect(meta(p)).toEqual({
      srcType: "lora",
      direct: true,
      path: ["DH1FR-1"],
      receiver: CALL,
      rssi: -101,
      snr: 7,
      hwId: 8,
      firmware: "4.35t",
      batt: 87,
    });
    expect(p.parsed).toMatchObject({ lat: 46.6247, lon: 14.3053 });
  });

  it("a relayed LoRa hearing: the path, not direct", () => {
    const m = meta(receive(pos({ src: "DH1FR-1,OE8XYZ-1" })));
    expect(m).toMatchObject({ srcType: "lora", direct: false, path: ["DH1FR-1", "OE8XYZ-1"], rssi: -101 });
  });

  it("a server-relayed frame: no signal report", () => {
    const m = meta(receive(pos({ src_type: "udp" })));
    expect(m?.srcType).toBe("udp");
    expect(m?.rssi).toBeUndefined();
    expect(m?.snr).toBeUndefined();
    expect(m?.direct).toBe(false);
  });

  it("the node's own frame: no signal report", () => {
    const m = meta(receive(pos({ src_type: "node", src: CALL })));
    expect(m).toMatchObject({ srcType: "node", receiver: CALL });
    expect(m?.rssi).toBeUndefined();
  });

  it("drops out-of-range values rather than guessing", () => {
    const m = meta(receive(pos({ batt: 140, hw_id: 999, rssi: 20, snr: -99, firmware: "x".repeat(40) })));
    expect(m?.batt).toBeUndefined();
    expect(m?.hwId).toBeUndefined();
    expect(m?.rssi).toBeUndefined();
    expect(m?.snr).toBeUndefined();
    expect(m?.firmware).toBeUndefined();
  });

  it("a group message carries its msg_id, so the gateway stores it once; a position does not", () => {
    const g = receive(
      enc({ src_type: "lora", type: "msg", src: "DH1FR-1", dst: "232", msg: "QRV?", msg_id: "0a1b2c3d", rssi: -90 }),
    );
    expect(g.payload).toBe("{MG232:QRV?");
    expect(meta(g)?.msgId).toBe("0A1B2C3D");
    expect(meta(receive(pos()))?.msgId).toBeUndefined();
  });

  it("leaves the trust-relevant fields exactly as without metadata", () => {
    const p = receive(pos());
    expect(p).toMatchObject({ heardVia: "rf", igateCall: CALL, port: "meshcom", rxCall: CALL });
    const relayed = receive(pos({ src: "DH1FR-1,OE8XYZ-1" }));
    expect(relayed.heardVia).toBe("rf");
    expect(relayed.igateCall).toBeUndefined();
    const server = receive(pos({ src_type: "udp" }));
    expect(server.heardVia).toBe("aprs_is");
    expect(server.igateCall).toBeUndefined();
  });
});
