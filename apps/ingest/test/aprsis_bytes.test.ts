// SPDX-License-Identifier: AGPL-3.0-or-later
// The APRS-IS feed passes each line on one character per byte, the form an info field heard on RF takes,
// whatever character set its sender used; the gateway reads the text out of it (`rfText`).
import { describe, it, expect } from "vitest";
import net from "node:net";
import { rfText } from "@aprscaching/aprs";
import { AprsIs } from "../src/aprsis.js";

describe("APRS-IS feed bytes", () => {
  it("emits a UTF-8 and a Latin-1 line one character per byte, the first split mid-character", async () => {
    const utf8Line = Buffer.from("OE8ABC>APRS,TCPIP*,qAC,T2AUSTRIA::OE5XYZ   :Grüße{1\r\n", "utf8");
    const latin1Line = Buffer.from("OE8ABC>APRS,TCPIP*,qAC,T2AUSTRIA:>Grüße\r\n", "latin1");
    const cut = utf8Line.indexOf(0xc3) + 1; // between the two bytes of "ü"
    const conns: net.Socket[] = [];
    const srv = net.createServer((s) => {
      conns.push(s);
      s.write(utf8Line.subarray(0, cut));
      setTimeout(() => s.write(Buffer.concat([utf8Line.subarray(cut), latin1Line])), 20);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const is = new AprsIs({
      host: "127.0.0.1",
      port: (srv.address() as net.AddressInfo).port,
      callsign: "N0CALL",
      passcode: "-1",
      filter: "t/m",
      retryMs: 60_000,
    });
    const lines: string[] = [];
    const got = new Promise<void>((resolve) =>
      is.on("line", (l: string) => {
        lines.push(l);
        if (lines.length === 2) resolve();
      }),
    );
    is.on("down", () => {});
    is.start();
    await got;
    for (const c of conns) c.destroy();
    srv.close();
    expect(lines).toEqual([utf8Line.subarray(0, -2).toString("latin1"), latin1Line.subarray(0, -2).toString("latin1")]);
    expect(lines.map(rfText)).toEqual([
      "OE8ABC>APRS,TCPIP*,qAC,T2AUSTRIA::OE5XYZ   :Grüße{1",
      "OE8ABC>APRS,TCPIP*,qAC,T2AUSTRIA:>Grüße",
    ]);
  });
});
