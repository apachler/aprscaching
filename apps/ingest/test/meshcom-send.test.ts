// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import dgram from "node:dgram";
import { MeshcomSender, type MeshcomAuditEntry, type MeshcomSenderOpts } from "../src/meshcom-send.js";

const NODE = { ip: "192.168.1.50", call: "OE8APR-12" };

function make(opts: Partial<MeshcomSenderOpts> = {}, clock = { t: 0 }) {
  const sent: { datagram: string; port: number; host: string }[] = [];
  const audit: MeshcomAuditEntry[] = [];
  const s = new MeshcomSender(
    { enabled: true, operatorCall: "OE8APR", nodes: [NODE], ...opts },
    {
      now: () => clock.t,
      send: async (datagram, port, host) => {
        sent.push({ datagram, port, host });
      },
      audit: (e) => {
        audit.push(e);
      },
    },
  );
  return { s, sent, audit, clock };
}
const req = (over: object = {}) => ({ dst: "DH1FR-1", text: "73", feature: "test", ...over });

describe("MeshCom sender — opt-in and operator control", () => {
  it("is off unless enabled", async () => {
    const { s, sent } = make({ enabled: false });
    expect(await s.send(req())).toEqual({ ok: false, reason: "disabled" });
    expect(sent).toHaveLength(0);
  });
  it("needs the operator's callsign", async () => {
    const { s } = make({ operatorCall: undefined });
    expect(await s.send(req())).toEqual({ ok: false, reason: "no-operator-call" });
  });
  it("refuses when the node transmits under a call other than the operator's", async () => {
    const { s, sent } = make({ operatorCall: "DL1ABC" });
    expect(await s.send(req())).toEqual({ ok: false, reason: "call-mismatch" });
    expect(sent).toHaveLength(0);
  });
  it("refuses a node whose call is not configured, and a node that is not allowlisted", async () => {
    expect(await make({ nodes: [{ ip: "192.168.1.50" }] }).s.send(req())).toEqual({
      ok: false,
      reason: "node-call-unknown",
    });
    expect(await make().s.send(req({ node: "10.0.0.9" }))).toEqual({ ok: false, reason: "node-not-allowlisted" });
  });
});

describe("MeshCom sender — scope and encoding", () => {
  it("sends a direct message to the node's ExtUDP port and reports it as handed to the node", async () => {
    const { s, sent } = make();
    expect(await s.send(req({ text: "Grüße 73" }))).toEqual({
      ok: true,
      status: "handed-to-node",
      node: NODE.ip,
      dst: "DH1FR-1",
      bytes: 10,
    });
    expect(sent).toEqual([{ datagram: '{"type":"msg","dst":"DH1FR-1","msg":"Grüße 73"}', port: 1799, host: NODE.ip }]);
  });
  it("refuses groups and broadcast", async () => {
    const { s, sent } = make();
    expect(await s.send(req({ dst: "262" }))).toEqual({ ok: false, reason: "dst-not-allowed" });
    expect(await s.send(req({ dst: "*" }))).toEqual({ ok: false, reason: "dst-not-allowed" });
    expect(sent).toHaveLength(0);
  });
  it("refuses text over 150 UTF-8 bytes", async () => {
    const { s } = make();
    expect((await s.send(req({ text: "a".repeat(150) }))).ok).toBe(true);
    expect(await s.send(req({ text: "ü".repeat(76) }))).toEqual({ ok: false, reason: "text-too-long" });
  });
});

describe("MeshCom sender — rate limit and audit", () => {
  it("caps a burst and refills at the configured rate", async () => {
    const { s, sent, clock } = make({ refillSec: 60, burst: 3 });
    const results = [];
    for (let i = 0; i < 10; i++) results.push((await s.send(req())).ok);
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(sent).toHaveLength(3);
    clock.t += 60_000;
    expect((await s.send(req())).ok).toBe(true);
    expect((await s.send(req())).ok).toBe(false);
  });
  it("audits every attempt with time, destination, length and feature — never the text", async () => {
    const { s, audit } = make();
    await s.send(req({ text: "secret words", feature: "find-confirmation" }));
    await s.send(req({ dst: "*", feature: "bot" }));
    expect(audit).toEqual([
      {
        at: "1970-01-01T00:00:00.000Z",
        feature: "find-confirmation",
        node: NODE.ip,
        dst: "DH1FR-1",
        bytes: 12,
        outcome: "handed-to-node",
      },
      {
        at: "1970-01-01T00:00:00.000Z",
        feature: "bot",
        node: NODE.ip,
        dst: "*",
        bytes: null,
        outcome: "dst-not-allowed",
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("secret");
  });
  it("reports a socket failure without claiming the message went out", async () => {
    const s = new MeshcomSender(
      { enabled: true, operatorCall: "OE8APR", nodes: [NODE] },
      { send: () => Promise.reject(new Error("EHOSTUNREACH")), audit: () => {} },
    );
    expect(await s.send(req())).toEqual({ ok: false, reason: "socket-error" });
  });
});

describe("MeshCom sender — over a real socket", () => {
  it("delivers the datagram to a UDP listener standing in for the node", async () => {
    const node = dgram.createSocket("udp4");
    await new Promise<void>((r) => node.bind(0, "127.0.0.1", () => r()));
    const got = new Promise<string>((r) => node.once("message", (m) => r(m.toString())));
    const s = new MeshcomSender(
      {
        enabled: true,
        operatorCall: "OE8APR",
        nodes: [{ ip: "127.0.0.1", call: "OE8APR-12" }],
        port: node.address().port,
      },
      { audit: () => {} },
    );
    expect((await s.send(req())).ok).toBe(true);
    expect(JSON.parse(await got)).toEqual({ type: "msg", dst: "DH1FR-1", msg: "73" });
    s.close();
    node.close();
  });
});
