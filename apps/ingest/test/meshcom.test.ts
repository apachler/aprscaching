// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import dgram from "node:dgram";
import type { Packet } from "@aprscaching/shared";
import { MeshcomListener, parseMeshcomNodes, parseMeshcomFanout, lanAddressFor } from "../src/meshcom.js";

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
    aprs_symbol: "#",
    aprs_symbol_group: "/",
    msg_id: "0A1B2C3D",
    rssi: -101,
    snr: 7,
    ...over,
  });
const msg = (over: object = {}) =>
  enc({
    src_type: "lora",
    type: "msg",
    src: "DH1FR-1",
    dst: CALL,
    msg: "hi{12",
    msg_id: "11223344",
    rssi: -90,
    snr: 4,
    ...over,
  });

function make(opts: Partial<ConstructorParameters<typeof MeshcomListener>[0]> = {}) {
  const out: Packet[] = [];
  const logs: string[] = [];
  const log = {
    log: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(`WARN ${m}`),
    error: (m: string) => logs.push(`ERR ${m}`),
  };
  const l = new MeshcomListener({ nodes: [{ ip: NODE, call: CALL }], ...opts }, (p) => out.push(p), log);
  return { l, out, logs };
}

describe("MeshCom listener — configuration", () => {
  it("parses node addresses with optional callsigns", () => {
    expect(parseMeshcomNodes("192.168.1.50=oe8apr-12, 192.168.1.51")).toEqual([
      { ip: "192.168.1.50", call: "OE8APR-12" },
      { ip: "192.168.1.51" },
    ]);
  });
  it("parses fan-out targets and skips malformed ones", () => {
    expect(parseMeshcomFanout("127.0.0.1:1800, nope, 10.0.0.2:99999")).toEqual([{ host: "127.0.0.1", port: 1800 }]);
    expect(parseMeshcomFanout(undefined)).toEqual([]);
  });
  it("finds this host's address on the node's subnet", () => {
    const ifaces = {
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
      eth0: [{ address: "192.168.1.10", netmask: "255.255.255.0", family: "IPv4", internal: false }],
      wg0: [{ address: "10.8.0.2", netmask: "255.255.255.0", family: "IPv4", internal: false }],
    } as unknown as Parameters<typeof lanAddressFor>[1];
    expect(lanAddressFor("192.168.1.50", ifaces)).toBe("192.168.1.10");
    expect(lanAddressFor("172.16.0.5", ifaces)).toBeNull();
    expect(lanAddressFor("not-an-ip", ifaces)).toBeNull();
  });
});

describe("MeshCom listener — allowlist and limits", () => {
  it("drops and counts a datagram from an address that is not a configured node", () => {
    const { l, out } = make();
    expect(l.receive(pos(), "192.168.1.66")).toBeNull();
    expect(out).toHaveLength(0);
    expect(l.counters.rejected["not-allowlisted"]).toBe(1);
  });
  it("drops an oversized datagram", () => {
    const { l } = make();
    expect(l.receive(new Uint8Array(4096), NODE)).toBeNull();
    expect(l.counters.rejected["too-large"]).toBe(1);
  });
  it("caps an inbound flood per node", () => {
    const { l, out } = make({ ratePerSec: 5, rateBurst: 10 });
    for (let i = 0; i < 100; i++) l.receive(pos({ msg_id: i.toString(16) }), NODE, 1000);
    expect(out).toHaveLength(10);
    expect(l.counters.rejected["rate-limited"]).toBe(90);
    l.receive(pos({ msg_id: "FFFF" }), NODE, 2000); // one second later: 5 tokens back
    expect(out).toHaveLength(11);
  });
  it("counts decode failures by reason", () => {
    const { l } = make();
    l.receive(new TextEncoder().encode("not json"), NODE);
    l.receive(pos({ lat: 0, long: 0 }), NODE);
    expect(l.counters.rejected).toMatchObject({ "not-json": 1, "no-fix": 1 });
  });
});

describe("MeshCom listener — provenance stamped on forwarded packets", () => {
  it("a direct LoRa hearing is RF with the node as gate", () => {
    const { l } = make();
    expect(l.receive(pos(), NODE)).toMatchObject({ heardVia: "rf", igateCall: CALL, port: "meshcom", path: [] });
  });
  it("a relayed LoRa frame is RF with no gate and keeps the relay path", () => {
    const { l } = make();
    const p = l.receive(pos({ src: "DH1FR-1,OE1XOR-12" }), NODE)!;
    expect(p).toMatchObject({ heardVia: "rf", path: ["OE1XOR-12"] });
    expect(p.igateCall).toBeUndefined();
  });
  it("a server-relayed frame is internet-sourced with no gate", () => {
    const { l } = make();
    const p = l.receive(pos({ src_type: "udp" }), NODE)!;
    expect(p.heardVia).toBe("aprs_is");
    expect(p.igateCall).toBeUndefined();
  });
  it("without a configured node call a direct hearing names no gate", () => {
    const { l } = make({ nodes: [{ ip: NODE }] });
    expect(l.receive(pos(), NODE)!.igateCall).toBeUndefined();
  });
  it("the node's own back-pressure notice is not RF", () => {
    const { l } = make();
    expect(
      l.receive(msg({ src: CALL, dst: "DH1FR-1", msg: "QRT NOT SENT - hi", rssi: 0, snr: 0 }), NODE)!.heardVia,
    ).toBe("aprs_is");
  });
});

describe("MeshCom listener — dedup", () => {
  it("forwards one copy, and again when a stronger RF copy follows a server copy", () => {
    const { l, out } = make();
    l.receive(pos({ src_type: "udp" }), NODE, 0);
    l.receive(pos({ src_type: "udp" }), NODE, 100);
    l.receive(pos(), NODE, 200);
    l.receive(pos(), NODE, 300);
    expect(out.map((p) => p.heardVia)).toEqual(["aprs_is", "rf"]);
    expect(l.counters).toMatchObject({ deduped: 2, upgraded: 1, forwarded: 2 });
  });
  it("counts telemetry without forwarding it", () => {
    const { l, out } = make();
    l.receive(enc({ src_type: "node", type: "tele", src: CALL, temp1: 12 }), NODE);
    expect(out).toHaveLength(0);
    expect(l.counters.tele).toBe(1);
  });
});

describe("MeshCom listener — operator signals", () => {
  it("warns once about firmware with the ExtUDP crash, from the node's own frames", () => {
    const { l, logs } = make();
    l.receive(pos({ src_type: "node", src: CALL, firmware: "4.35", fw_sub: "p", rssi: 0, snr: 0, msg_id: "1" }), NODE);
    l.receive(pos({ src_type: "node", src: CALL, firmware: "4.35", fw_sub: "p", rssi: 0, snr: 0, msg_id: "2" }), NODE);
    expect(logs.filter((m) => m.startsWith("WARN") && m.includes("4.35p"))).toHaveLength(1);
  });
  it("flags 4.35t as possibly affected and says nothing for newer firmware", () => {
    const t = make();
    t.l.receive(pos({ src_type: "node", src: CALL, firmware: "4.35", fw_sub: "t", rssi: 0, snr: 0 }), NODE);
    expect(t.logs.some((m) => m.includes("before 2026-09-25"))).toBe(true);
    const u = make();
    u.l.receive(pos({ src_type: "node", src: CALL, firmware: "4.35", fw_sub: "u", rssi: 0, snr: 0 }), NODE);
    expect(u.logs.filter((m) => m.startsWith("WARN"))).toHaveLength(0);
  });
  it("warns once when the node goes quiet, and again only after it spoke", () => {
    const { l, logs } = make({ staleMs: 60_000 });
    l.receive(pos(), NODE, 1_000);
    expect(l.checkStale(30_000)).toBe(false);
    expect(l.checkStale(62_000)).toBe(true);
    expect(l.checkStale(90_000)).toBe(false);
    l.receive(pos({ msg_id: "2" }), NODE, 100_000);
    expect(l.checkStale(170_000)).toBe(true);
    expect(logs.filter((m) => m.startsWith("WARN") && m.includes("no datagram"))).toHaveLength(2);
  });
  it("never puts message text in the counters line", () => {
    const { l } = make();
    l.receive(msg({ msg: "secret words" }), NODE);
    expect(JSON.stringify(l.stats())).not.toContain("secret");
  });
});

/** Bind a listener on loopback and wait until it is ready. */
async function started(opts: Partial<ConstructorParameters<typeof MeshcomListener>[0]> = {}) {
  const m = make({ nodes: [{ ip: "127.0.0.1", call: CALL }], port: 0, bind: "127.0.0.1", ...opts });
  m.l.start();
  await new Promise<void>((r) => m.l.socket!.once("listening", () => r()));
  return { ...m, port: m.l.socket!.address().port };
}
const send = (port: number, data: Uint8Array) =>
  new Promise<void>((r) => {
    const tx = dgram.createSocket("udp4");
    tx.send(data, port, "127.0.0.1", () => {
      tx.close();
      r();
    });
  });
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("MeshCom listener — over a real socket", () => {
  it("receives fixtures sent over loopback and emits normalised packets", async () => {
    const { l, out, port } = await started();
    await send(port, msg());
    await send(port, pos({ src: "9V1LH-1,OE1KBC-12", msg_id: "AE48D54D" }));
    await until(() => out.length === 2);
    l.stop();
    expect(out.map((p) => [p.src, p.kind, p.heardVia])).toEqual([
      ["DH1FR-1", "message", "rf"],
      ["9V1LH-1", "position", "rf"],
    ]);
  });

  it("passes allowlisted raw datagrams on to fan-out targets", async () => {
    const sink = dgram.createSocket("udp4");
    await new Promise<void>((r) => sink.bind(0, "127.0.0.1", () => r()));
    const got: string[] = [];
    sink.on("message", (m) => got.push(m.toString()));
    const { l, port } = await started({ fanout: [{ host: "127.0.0.1", port: sink.address().port }] });
    await send(port, msg());
    await until(() => got.length === 1);
    l.stop();
    sink.close();
    expect(JSON.parse(got[0]!)).toMatchObject({ type: "msg", src: "DH1FR-1" });
  });

  it("fails fast with an actionable message when the port is taken", async () => {
    const holder = dgram.createSocket("udp4");
    await new Promise<void>((r) => holder.bind(0, "127.0.0.1", () => r()));
    const m = make({ nodes: [{ ip: "127.0.0.1" }], port: holder.address().port, bind: "127.0.0.1" });
    m.l.start();
    await until(() => m.logs.some((x) => x.startsWith("ERR")));
    holder.close();
    expect(m.logs.find((x) => x.startsWith("ERR"))).toMatch(/already in use.*MESHCOM_FANOUT/);
    expect(m.l.socket).toBeUndefined();
  });
});
