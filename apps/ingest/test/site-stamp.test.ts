// SPDX-License-Identifier: AGPL-3.0-or-later
// The direct-hearing site stamp, shared by every local TNC driver: a frame the box heard straight from
// the originator names the box's site; a digipeated frame, or a box without a site call, names none.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { encodeAx25, kissWrap } from "@aprscaching/aprs";
import { encodeAgwpe } from "@aprscaching/packet";
import type { Packet } from "@aprscaching/shared";
import { directSiteCall } from "../src/link.js";
import { KissTnc } from "../src/kiss.js";
import { AgwpeTnc } from "../src/agwpe.js";
import { monitorHeaderToTnc2, hostmodeMonitorPacket } from "../src/hostmode.js";

const DIRECT = { src: "OE3PLY-7", dst: "APRS", path: ["WIDE1-1", "WIDE2-1"], payload: "!4704.41N/01526.27E>direct" };
const RELAYED = {
  src: "OE3PLY-7",
  dst: "APRS",
  path: ["OE8XBM-10*", "WIDE2-1"],
  payload: "!4704.41N/01526.27E>relayed",
};

describe("directSiteCall", () => {
  it("names the site on a frame heard directly (an unused WIDE hop is not a relay)", () => {
    expect(directSiteCall([], "oe8apr-10")).toBe("OE8APR-10");
    expect(directSiteCall(["WIDE1-1", "WIDE2-1"], "OE8APR-10")).toBe("OE8APR-10");
  });
  it("names no site on a digipeated frame", () => {
    expect(directSiteCall(["OE8XBM-10*", "WIDE2-1"], "OE8APR-10")).toBeUndefined();
    expect(directSiteCall(["WIDE1*", "WIDE2-1"], "OE8APR-10")).toBeUndefined();
  });
  it("names no site without a site call", () => {
    expect(directSiteCall([], undefined)).toBeUndefined();
    expect(directSiteCall([], "  ")).toBeUndefined();
  });
});

/** A one-shot fake TNC: accepts one connection, writes `bytes`, and resolves the collected packets. */
async function viaFakeTnc(
  bytes: Uint8Array,
  start: (port: number, onPacket: (p: Packet) => void) => { stop?: () => void },
): Promise<Packet[]> {
  const got: Packet[] = [];
  const server = net.createServer((sock) => sock.write(bytes));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  start(port, (p) => got.push(p));
  const t0 = Date.now();
  while (got.length < 2 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  server.close();
  return got;
}
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("KISS TNC", () => {
  it.each([
    ["OE8APR-10", ["OE8APR-10", undefined]],
    [undefined, [undefined, undefined]],
  ])("with site %s stamps only the direct frame", async (site, expected) => {
    const bytes = Uint8Array.from([...kissWrap(encodeAx25(DIRECT)), ...kissWrap(encodeAx25(RELAYED))]);
    const got = await viaFakeTnc(bytes, (port, onPacket) => {
      const k = new KissTnc({ host: "127.0.0.1", port, siteCall: site }, { onPacket });
      k.start();
      cleanups.push(() => (k as unknown as { sock?: net.Socket }).sock?.destroy());
      return {};
    });
    expect(got.map((p) => [p.port, p.heardVia])).toEqual([
      ["kiss-tnc", "rf"],
      ["kiss-tnc", "rf"],
    ]);
    expect(got.map((p) => p.igateCall)).toEqual(expected);
  });
});

describe("AGWPE", () => {
  const monitor = (f: typeof DIRECT) =>
    encodeAgwpe({ port: 0, kind: "K", from: f.src, to: f.dst, data: Uint8Array.from([0, ...encodeAx25(f)]) });

  it.each([
    ["OE8APR-10", ["OE8APR-10", undefined]],
    [undefined, [undefined, undefined]],
  ])("with site %s stamps only the direct frame", async (site, expected) => {
    const bytes = Uint8Array.from([...monitor(DIRECT), ...monitor(RELAYED)]);
    const got = await viaFakeTnc(bytes, (port, onPacket) => {
      const a = new AgwpeTnc({ host: "127.0.0.1", port, siteCall: site }, { onPacket });
      a.start();
      cleanups.push(() => (a as unknown as { sock?: net.Socket }).sock?.destroy());
      return {};
    });
    expect(got.map((p) => [p.port, p.heardVia])).toEqual([
      ["agwpe", "rf"],
      ["agwpe", "rf"],
    ]);
    expect(got.map((p) => p.igateCall)).toEqual(expected);
  });
});

describe("WA8DED host mode", () => {
  const info = new TextEncoder().encode("!4704.41N/01526.27E>hi");

  it("reads the TheFirmware monitor header, keeping the repeated marker", () => {
    expect(monitorHeaderToTnc2("fm OE3PLY-7 to APRS via WIDE1-1 WIDE2-1 ctl UI^ pid F0")).toBe(
      "OE3PLY-7>APRS,WIDE1-1,WIDE2-1",
    );
    expect(monitorHeaderToTnc2("fm OE3PLY-7 to APRS via OE8XBM-10* WIDE2-1 ctl UI pid F0")).toBe(
      "OE3PLY-7>APRS,OE8XBM-10*,WIDE2-1",
    );
    expect(monitorHeaderToTnc2("fm OE3PLY-7 to APRS ctl UI^ pid F0")).toBe("OE3PLY-7>APRS");
    expect(monitorHeaderToTnc2("OE3PLY-7>APRS,WIDE1-1")).toBe("OE3PLY-7>APRS,WIDE1-1");
    expect(monitorHeaderToTnc2("*** connected to DB0XYZ")).toBeNull();
  });

  it("stamps the site on a direct frame and not on a digipeated one", () => {
    const direct = hostmodeMonitorPacket("fm OE3PLY-7 to APRS via WIDE1-1 ctl UI^ pid F0", info, "OE8APR-10", 1)!;
    const relayed = hostmodeMonitorPacket("fm OE3PLY-7 to APRS via OE8XBM-10* ctl UI pid F0", info, "OE8APR-10", 1)!;
    expect(direct.packet).toMatchObject({ port: "hostmode", heardVia: "rf", igateCall: "OE8APR-10", src: "OE3PLY-7" });
    expect(relayed.packet.igateCall).toBeUndefined();
    expect(hostmodeMonitorPacket("fm OE3PLY-7 to APRS ctl UI^", info, undefined, 1)!.packet.igateCall).toBeUndefined();
  });
});
