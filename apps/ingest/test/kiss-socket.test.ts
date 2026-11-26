// SPDX-License-Identifier: AGPL-3.0-or-later
// A KISS TNC on a Unix socket: KISS_TNC_HOST starting with `/` is the socket's path, as a Pocket station's USB
// bridge serves it in Termux's private directory. The client connects by that path, never to a TCP port,
// where another app on the phone could stand in for the TNC and feed frames that count as this site's hearing.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { encodeAx25, kissWrap } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { KissTnc } from "../src/kiss.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};
const ui = (payload: string) => kissWrap(encodeAx25({ src: "OE3PLY-7", dst: "APRS", payload }));

describe("KissTnc on a Unix socket", () => {
  it("connects by the path in KISS_TNC_HOST, hears and sends through it, and dials no TCP port", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-kiss-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, "kiss.sock");
    const fromBox: Buffer[] = [];
    const bridge = net.createServer((c) => {
      c.on("error", () => {});
      c.on("data", (d: Buffer) => fromBox.push(d));
      c.write(Buffer.from(ui(">heard on the radio")));
    });
    await new Promise<void>((r) => bridge.listen(sock, r));
    cleanups.push(() => bridge.close());
    // Another app holding a TCP port: the port given beside the path must not be dialled.
    let tcpClients = 0;
    const squatter = net.createServer((c) => {
      tcpClients++;
      c.write(Buffer.from(ui(">forged")));
    });
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    cleanups.push(() => squatter.close());
    const port = (squatter.address() as net.AddressInfo).port;

    const got: Packet[] = [];
    const tnc = new KissTnc({ host: sock, port }, { onPacket: (p) => got.push(p) });
    tnc.start();
    cleanups.push(() => tnc["link"].stop());
    await until(() => got.length >= 1);
    expect(got.map((p) => p.payload)).toEqual([">heard on the radio"]);
    expect(tnc.send({ src: "OE8APR", dst: "APRS", payload: ">out" })).toBe(true);
    await until(() => fromBox.length >= 1);
    expect(Buffer.concat(fromBox).includes(Buffer.from(">out"))).toBe(true);
    expect(tcpClients).toBe(0);
  });
});
