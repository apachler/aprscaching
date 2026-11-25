// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NetromNodeRunner } from "../src/netromnode.js";
import { encodeFrame, encodeAddress, parseAddr, PID_NETROM, type Ax25Frame } from "@aprscaching/ax25";
import {
  encodeNodesBroadcast,
  encodeNetrom,
  decodeNetrom,
  encodeRif,
  decodeL3rttFrame,
  INP_RIF,
  NrOp,
} from "@aprscaching/packet";

const enc = new TextEncoder();

function runner() {
  const sent: Ax25Frame[] = [];
  const link = {
    sendFrame: (f: Ax25Frame) => {
      sent.push(f);
    },
    onRaw: () => {},
  };
  const node = new NetromNodeRunner(link as never, { mycall: "OE1ACS-7", alias: "ACS" });
  return { node, sent };
}

/** A NODES payload: 0xFF + 6-char sender mnemonic (+ optional route entries). */
const nodesInfo = (alias: string) => Uint8Array.from([0xff, ...enc.encode(alias.padEnd(6))]);

describe("NetromNodeRunner NODES learning", () => {
  it("learns the broadcaster from a classic broadcast to NODES", () => {
    const { node } = runner();
    node.onRaw(
      encodeFrame({
        dst: parseAddr("NODES"),
        src: parseAddr("OE9NOS-1"),
        command: true,
        type: "UI",
        pf: false,
        pid: PID_NETROM,
        info: nodesInfo("NOS"),
      }),
    );
    const routes = node.nodeStore(() => []).nodes();
    expect(routes.some((r) => r.call === "OE9NOS-1" && r.alias === "NOS")).toBe(true);
  });

  it("learns from a TheNet-style broadcast DIRECTED to our callsign (TNN behaviour)", () => {
    const { node } = runner();
    node.onRaw(
      encodeFrame({
        dst: parseAddr("OE1ACS-7"), // TNN addresses NODES records to the registered neighbour
        src: parseAddr("OE9TNN"),
        command: true,
        type: "UI",
        pf: false,
        pid: PID_NETROM,
        info: nodesInfo("TNN"),
      }),
    );
    const routes = node.nodeStore(() => []).nodes();
    expect(routes.some((r) => r.call === "OE9TNN" && r.alias === "TNN")).toBe(true);
  });
});

describe("NetromNodeRunner answers a newly heard node", () => {
  const broadcastFrom = (call: string, alias: string) =>
    encodeFrame({
      dst: parseAddr("NODES"),
      src: parseAddr(call),
      command: true,
      type: "UI",
      pf: false,
      pid: PID_NETROM,
      info: nodesInfo(alias),
    });
  const ourBroadcasts = (sent: Ax25Frame[]) =>
    sent.filter((f) => f.pid === PID_NETROM && f.dst.call === "NODES" && f.src.call === "OE1ACS").length;

  it("sends one NODES broadcast for a new node, none for a node already heard", () => {
    const { node, sent } = runner();
    node.onRaw(broadcastFrom("OE9NOS-1", "NOS"));
    expect(ourBroadcasts(sent)).toBe(1);
    node.onRaw(broadcastFrom("OE9NOS-1", "NOS"));
    expect(ourBroadcasts(sent)).toBe(1);
  });

  it("answers at most once a minute however many new nodes appear", () => {
    const { node, sent } = runner();
    node.onRaw(broadcastFrom("OE9NOS-1", "NOS"));
    node.onRaw(broadcastFrom("OE9TWO-1", "TWO"));
    expect(ourBroadcasts(sent)).toBe(1);
  });
});

const ui = (src: string, dst: string, info: Uint8Array) =>
  encodeFrame({
    dst: parseAddr(dst),
    src: parseAddr(src),
    command: true,
    type: "UI",
    pf: false,
    pid: PID_NETROM,
    info,
  });
/** A call per index, distinct for every i: what a forger rotating its source call sends. */
const forged = (prefix: string, i: number) => prefix + i.toString(36).toUpperCase().padStart(5, "0");

describe("NetromNodeRunner mirrors the routing table once per change", () => {
  let posts: { nodes?: unknown[] }[] = [];
  let reply: () => Response;
  beforeEach(() => {
    posts = [];
    reply = () => new Response("{}", { status: 201 });
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)) as { nodes?: unknown[] });
      return reply();
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const mirroring = () => {
    const sent: Ax25Frame[] = [];
    const link = { sendFrame: (f: Ax25Frame) => void sent.push(f), onRaw: () => {} };
    const node = new NetromNodeRunner(link as never, {
      mycall: "OE1ACS-7",
      alias: "ACS",
      gatewayBase: "http://127.0.0.1:9",
      secret: "s",
    });
    return node;
  };
  const broadcast = (i: number) =>
    encodeNodesBroadcast(
      "EVIL",
      Array.from({ length: 11 }, (_, k) => ({
        dest: parseAddr(forged("Z", 1e6 + i * 11 + k)),
        alias: "X",
        neighbor: parseAddr(forged("Z", i)),
        quality: 255,
      })),
    )[0]!;

  it("sends one request for a flood of forged NODES broadcasts, carrying each changed route once", async () => {
    const node = mirroring();
    const N = 200;
    for (let i = 0; i < N; i++) node.onRaw(ui(forged("Z", i), "NODES", broadcast(i)));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posts.length).toBe(1);
    expect(posts[0]!.nodes!.length).toBe(500); // the whole capped table, once
    for (let i = 0; i < N; i++) node.onRaw(ui(forged("Z", i), "NODES", broadcast(i))); // refreshes only
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts.length).toBe(1);
  });

  it("retries a failed mirror at the next interval, and stops once it is stored", async () => {
    const node = mirroring();
    reply = () => new Response("down", { status: 503 });
    node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS")));
    await vi.advanceTimersByTimeAsync(30_000);
    reply = () => new Response("{}", { status: 201 });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts.map((p) => p.nodes!.length)).toEqual([1, 1]);
  });

  it("does not resend a route the gateway refused until it changes", async () => {
    const node = mirroring();
    reply = () =>
      new Response(JSON.stringify({ ok: true, stored: 0, refused: [{ index: 0, dest: "OE9NOS-1", error: "x" }] }), {
        status: 201,
      });
    node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS")));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts.length).toBe(1);
  });

  it("sends only the routes a later broadcast changed", async () => {
    const node = mirroring();
    node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS")));
    await vi.advanceTimersByTimeAsync(30_000);
    node.onRaw(ui("OE9TWO-1", "NODES", nodesInfo("TWO")));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posts.map((p) => p.nodes!.map((n) => (n as { dest: string }).dest))).toEqual([["OE9NOS-1"], ["OE9TWO-1"]]);
  });
});

describe("NetromNodeRunner bounds the INP3 neighbour set", () => {
  const inp3 = () => {
    const sent: Ax25Frame[] = [];
    const link = { sendFrame: (f: Ax25Frame) => void sent.push(f), onRaw: () => {} };
    const node = new NetromNodeRunner(link as never, { mycall: "OE1ACS-7", alias: "ACS", inp3: true });
    return { node, sent };
  };

  it("keeps forged NODES sources to the cap and their transmissions to the bucket", () => {
    const { node, sent } = inp3();
    for (let i = 0; i < 2000; i++) node.onRaw(ui(forged("F", i) + "-1", "NODES", nodesInfo("FAKE")));
    const nb = (node as unknown as { neighbors: Map<string, unknown> }).neighbors;
    expect(nb.size).toBeLessThanOrEqual(16);
    expect(sent.length).toBeLessThanOrEqual(11); // the strangers' share (half the burst of 20), one NODES answer
    sent.length = 0;
    (node as unknown as { probeNeighbors(): void }).probeNeighbors(); // one 60 s round, bucket empty
    expect(sent.length).toBe(0);
  });

  it("exchanges routes with a neighbour only once it answers a probe", () => {
    const { node, sent } = inp3();
    node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS")));
    const probe = sent.find((f) => f.dst.call === "OE9NOS" && decodeL3rttFrame(f.info!));
    expect(probe).toBeDefined();
    expect(sent.some((f) => f.dst.call === "OE9NOS" && f.info?.[0] === INP_RIF)).toBe(false); // no table yet
    // a RIF from it before it answers teaches nothing
    node.onRaw(ui("OE9NOS-1", "OE1ACS-7", encodeRif([{ dest: parseAddr("OE5FAR"), hops: 1, tt: 10, alias: "FAR" }])));
    expect(
      node
        .nodeStore(() => [])
        .nodes()
        .some((r) => r.call === "OE5FAR"),
    ).toBe(false);
    node.onRaw(ui("OE9NOS-1", "OE1ACS-7", probe!.info!)); // it echoes our probe
    expect(sent.some((f) => f.dst.call === "OE9NOS" && f.info?.[0] === INP_RIF)).toBe(true);
    node.onRaw(ui("OE9NOS-1", "OE1ACS-7", encodeRif([{ dest: parseAddr("OE5FAR"), hops: 1, tt: 10, alias: "FAR" }])));
    expect(
      node
        .nodeStore(() => [])
        .nodes()
        .some((r) => r.call === "OE5FAR"),
    ).toBe(true);
  });

  it("lets two INP3 nodes adopt each other from a NODES broadcast, with no static config", () => {
    const q: { to: "a" | "b"; f: Ax25Frame }[] = [];
    const mk = (call: string, to: "a" | "b") =>
      new NetromNodeRunner({ sendFrame: (f: Ax25Frame) => void q.push({ to, f }), onRaw: () => {} } as never, {
        mycall: call,
        alias: call.slice(0, 4),
        inp3: true,
      });
    const a = mk("OE1AAA-7", "b");
    const b = mk("OE2BBB-7", "a");
    a.onRaw(ui("OE2BBB-7", "NODES", nodesInfo("OE2B"))); // A hears B's broadcast
    for (let n = 0; q.length && n < 200; n++) {
      const { to, f } = q.shift()!;
      (to === "a" ? a : b).onRaw(encodeFrame(f));
    }
    const measured = (r: NetromNodeRunner) =>
      [...(r as unknown as { neighbors: Map<string, { srtt: number | null }> }).neighbors]
        .filter(([, v]) => v.srtt != null)
        .map(([k]) => k);
    expect(measured(a)).toEqual(["OE2BBB-7"]);
    expect(measured(b)).toEqual(["OE1AAA-7"]);
  });

  /** A runner with OE9NOS-1 as a measured neighbour: heard, probed, and its echo answered. */
  const withNeighbour = (opts: Record<string, unknown> = {}) => {
    const sent: Ax25Frame[] = [];
    const link = { sendFrame: (f: Ax25Frame) => void sent.push(f), onRaw: () => {} };
    const node = new NetromNodeRunner(link as never, { mycall: "OE1ACS-7", alias: "ACS", inp3: true, ...opts });
    node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS")));
    const probe = sent.find((f) => f.dst.call === "OE9NOS" && decodeL3rttFrame(f.info!))!;
    node.onRaw(ui("OE9NOS-1", "OE1ACS-7", probe.info!));
    return { node, sent };
  };
  const neighbours = (node: NetromNodeRunner) => [
    ...(node as unknown as { neighbors: Map<string, unknown> }).neighbors.keys(),
  ];

  it("keeps sending to a measured neighbour while forged sources flood the node", () => {
    const { node, sent } = withNeighbour();
    for (let i = 0; i < 2000; i++) node.onRaw(ui(forged("F", i) + "-1", "NODES", nodesInfo("FAKE")));
    sent.length = 0;
    (node as unknown as { advertiseAll(): void }).advertiseAll();
    expect(sent.some((f) => f.dst.call === "OE9NOS" && f.info?.[0] === INP_RIF)).toBe(true);
  });

  describe("on a clock", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("drops a candidate that has not answered a probe within 180 s", () => {
      const { node } = inp3();
      node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS")));
      const probe = () => (node as unknown as { probeNeighbors(): void }).probeNeighbors();
      vi.advanceTimersByTime(179_000);
      probe();
      expect(neighbours(node)).toEqual(["OE9NOS-1"]);
      vi.advanceTimersByTime(2_000);
      probe();
      expect(neighbours(node)).toEqual([]);
    });

    it("drops a neighbour not heard within the stale window, with its routes", () => {
      const { node } = withNeighbour({ broadcastMs: 60_000 });
      node.onRaw(ui("OE9NOS-1", "OE1ACS-7", encodeRif([{ dest: parseAddr("OE5FAR"), hops: 1, tt: 10, alias: "FAR" }])));
      node.start();
      const far = () =>
        node
          .nodeStore(() => [])
          .nodes()
          .some((r) => r.call === "OE5FAR");
      expect(far()).toBe(true);
      vi.advanceTimersByTime(180_000); // three broadcast intervals, the stale window, not yet past it
      expect(neighbours(node)).toEqual(["OE9NOS-1"]);
      vi.advanceTimersByTime(60_000);
      expect(neighbours(node)).toEqual([]);
      expect(far()).toBe(false);
    });
  });

  it("ignores a RIF sent to another station", () => {
    const { node, sent } = inp3();
    node.onRaw(ui("OE9NOS-1", "OE7OTH", encodeRif([{ dest: parseAddr("OE5FAR"), hops: 1, tt: 10, alias: "FAR" }])));
    expect(sent.length).toBe(0);
    expect((node as unknown as { neighbors: Map<string, unknown> }).neighbors.size).toBe(0);
  });
});

describe("NetromNodeRunner switches only frames sent to it", () => {
  const datagram = (l2dst: string) =>
    ui(
      "OE5XXX",
      l2dst,
      encodeNetrom({
        net: { origin: parseAddr("OE5XXX"), dest: parseAddr("OE9NOS-1"), ttl: 10 },
        tp: { opcode: NrOp.Info, flags: 0, circuitIndex: 1, circuitId: 1, txSeq: 0, rxSeq: 0 },
        info: enc.encode("hi"),
      }),
    );
  const transits = (sent: Ax25Frame[]) => sent.filter((f) => f.dst.call === "OE9NOS" && f.dst.ssid === 1).length;

  it("does not forward a datagram heard between two other stations", () => {
    const { node, sent } = runner();
    node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS"))); // a route to OE9NOS-1
    node.onRaw(datagram("OE7OTH"));
    expect(transits(sent)).toBe(0);
  });

  it("forwards one sent to it, paced by the strangers' share of the transmit bucket", () => {
    const { node, sent } = runner();
    node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS")));
    for (let i = 0; i < 100; i++) node.onRaw(datagram("OE1ACS-7"));
    expect(transits(sent)).toBe(10);
  });

  it.each([false, true])(
    "keeps forwarding a NODES-table neighbour's traffic while strangers flood the node (INP3 %s)",
    (inp3) => {
      const sent: Ax25Frame[] = [];
      const link = { sendFrame: (f: Ax25Frame) => void sent.push(f), onRaw: () => {} };
      const node = new NetromNodeRunner(link as never, { mycall: "OE1ACS-7", alias: "ACS", inp3 });
      node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS"))); // a route to OE9NOS-1
      node.onRaw(ui("OE9TWO-1", "NODES", nodesInfo("TWO"))); // OE9TWO-1 is a neighbour too, never probed
      for (let i = 0; i < 200; i++) node.onRaw(datagram("OE1ACS-7")); // a stranger's flood
      const before = transits(sent);
      const fromNeighbour = encodeNetrom({
        net: { origin: parseAddr("OE9TWO-1"), dest: parseAddr("OE9NOS-1"), ttl: 10 },
        tp: { opcode: NrOp.Info, flags: 0, circuitIndex: 1, circuitId: 1, txSeq: 0, rxSeq: 0 },
        info: enc.encode("hi"),
      });
      node.onRaw(ui("OE9TWO-1", "OE1ACS-7", fromNeighbour));
      expect(transits(sent) - before).toBe(1);
    },
  );

  it("keeps the MHeard list to its cap however many sources are heard", () => {
    const { node } = runner();
    for (let i = 0; i < 3000; i++) node.onRaw(ui(forged("H", i), "NODES", nodesInfo("H")));
    expect((node as unknown as { heard: Map<string, unknown> }).heard.size).toBeLessThanOrEqual(500);
  });
});

describe("NetromNodeRunner ties a circuit to the node at its far end", () => {
  const app = { greeting: () => ["hello"], handle: () => ({ lines: [] }) };
  const connReq = (origin: string, idx: number) =>
    ui(
      origin,
      "OE1ACS-7",
      encodeNetrom({
        net: { origin: parseAddr(origin), dest: parseAddr("OE1ACS-7"), ttl: 10 },
        tp: { opcode: NrOp.ConnReq, flags: 0, circuitIndex: idx, circuitId: idx, txSeq: 0, rxSeq: 0 },
        info: Uint8Array.from([
          4,
          ...encodeAddress(parseAddr("OE5USR"), false, false),
          ...encodeAddress(parseAddr(origin), false, true),
        ]),
      }),
    );
  const info = (origin: string, idx: number, id: number) =>
    ui(
      origin,
      "OE1ACS-7",
      encodeNetrom({
        net: { origin: parseAddr(origin), dest: parseAddr("OE1ACS-7"), ttl: 10 },
        tp: { opcode: NrOp.Info, flags: 0, circuitIndex: idx, circuitId: id, txSeq: 0, rxSeq: 0 },
        info: enc.encode("x\r"),
      }),
    );
  const acks = (sent: Ax25Frame[], to: string) =>
    sent.filter((f) => f.dst.call === to && decodeNetrom(f.info!)?.tp.opcode === NrOp.InfoAck).length;

  it("delivers a packet only from the node that opened the circuit", () => {
    const { node, sent } = runner();
    node.serveInbound(() => app as never);
    node.onRaw(connReq("OE5AAA", 7));
    const ack = sent.map((f) => decodeNetrom(f.info!)).find((p) => p?.tp.opcode === NrOp.ConnAck)!;
    const [idx, id] = [ack.tp.txSeq, ack.tp.rxSeq];
    node.onRaw(info("OE5BBB", idx, id)); // a guess at the same circuit from another node
    expect(acks(sent, "OE5BBB")).toBe(0);
    node.onRaw(info("OE5AAA", idx, id));
    expect(acks(sent, "OE5AAA")).toBe(1);
  });

  it("closes the relay of a connect-through dialled past a full circuit table", async () => {
    const { node, sent } = runner();
    node.serveInbound(() => app as never);
    node.onRaw(ui("OE9NOS-1", "NODES", nodesInfo("NOS"))); // a route to dial
    for (let i = 0; i < 64; i++) node.onRaw(connReq(forged("C", i), i + 1));
    sent.length = 0;
    const said: string[] = [];
    const relay = {
      toUser: (b: Uint8Array) => void said.push(new TextDecoder().decode(b)),
      attach: vi.fn(),
      detach: vi.fn(),
      disconnectUser: vi.fn(),
    };
    node.connectThrough()("OE9NOS-1", relay);
    await Promise.resolve();
    expect(sent.some((f) => decodeNetrom(f.info!)?.tp.opcode === NrOp.ConnReq)).toBe(false);
    expect(relay.detach).toHaveBeenCalled();
    expect(said.at(-1)).toMatch(/^Disconnected from OE9NOS-1/);
  });

  it("caps the circuits open at once", () => {
    const { node } = runner();
    node.serveInbound(() => app as never);
    for (let i = 0; i < 100; i++) node.onRaw(connReq(forged("C", i), i + 1));
    expect((node as unknown as { circuits: unknown[] }).circuits.length).toBe(64);
  });
});
