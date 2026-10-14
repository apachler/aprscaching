// SPDX-License-Identifier: AGPL-3.0-or-later
// APRS-IS carries bytes: an info field passes between RF and APRS-IS unchanged, whatever character set
// its sender used (here UTF-8 "Grüße").
import { describe, it, expect } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { Igate } from "../src/igate.js";
import type { KissTnc } from "../src/kiss.js";

const GRUESSE_UTF8 = Buffer.from("Grüße", "utf8"); // 47 72 c3 bc c3 9f 65
const asLatin1 = (b: Buffer) => b.toString("latin1"); // one character per byte, as AX.25 decoding gives it

describe("IGate byte fidelity", () => {
  it("relays RF bytes to APRS-IS and APRS-IS bytes to RF one for one", async () => {
    const fromGate: Buffer[] = [];
    let client: net.Socket | undefined;
    const server = net.createServer((s) => {
      client = s;
      s.on("data", (d) => fromGate.push(d));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const sent: { payload: string }[] = [];
    const kiss = { send: (f: { payload: string }) => (sent.push(f), true) } as unknown as KissTnc;
    const g = new Igate(kiss, { host: "127.0.0.1", port, call: "N0GATE-10", pass: "1", canTx: () => true });
    g.start();
    try {
      await new Promise((r) => setTimeout(r, 150));
      // RF -> APRS-IS: the frame's info field holds the UTF-8 bytes, one character each
      g.onRf({
        src: "OE1ABC-7",
        dst: "APRS",
        path: [],
        payload: `:N0GATE-10:${asLatin1(GRUESSE_UTF8)}`,
        raw: "",
      });
      await new Promise((r) => setTimeout(r, 100));
      const up = Buffer.concat(fromGate);
      expect(up.includes(GRUESSE_UTF8)).toBe(true);

      // APRS-IS -> RF: a message for the station just heard, its text in UTF-8 on the wire
      client!.write(
        Buffer.concat([Buffer.from("W2XYZ>APRS,TCPIP*,qAC,T2TEST::OE1ABC-7 :"), GRUESSE_UTF8, Buffer.from("{1\r\n")]),
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(sent).toHaveLength(1);
      expect(Buffer.from(sent[0]!.payload, "latin1").includes(GRUESSE_UTF8)).toBe(true);
    } finally {
      client?.destroy();
      server.close();
    }
  });
});
