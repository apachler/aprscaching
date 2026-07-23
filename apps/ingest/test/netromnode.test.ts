// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { NetromNodeRunner } from "../src/netromnode.js";
import { encodeFrame, parseAddr, PID_NETROM, type Ax25Frame } from "@aprscaching/ax25";

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
