// SPDX-License-Identifier: AGPL-3.0-or-later
// The gateway's service call on APRS-IS: the feed asks for messages addressed to it, and the uplink sends the
// service call's own answers as plain packets, a player's announced find as third-party traffic.
import { describe, it, expect } from "vitest";
import net from "node:net";
import { AprsIs } from "../src/aprsis.js";
import { AprsUplink, uplinkLogin } from "../src/uplink.js";

/** A TCP server that records every line it receives. */
function lineServer(): Promise<{ port: number; lines: string[]; close: () => void }> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const socks: net.Socket[] = [];
    const srv = net.createServer((s) => {
      socks.push(s);
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          lines.push(buf.slice(0, i).replace(/\r$/, ""));
          buf = buf.slice(i + 1);
        }
      });
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        lines,
        close: () => {
          for (const s of socks) s.destroy();
          srv.close();
        },
      }),
    );
  });
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("APRS-IS feed filter", () => {
  it("adds a group-message filter for the service call, at once on a live connection", async () => {
    const srv = await lineServer();
    const is = new AprsIs({
      host: "127.0.0.1",
      port: srv.port,
      callsign: "N0CALL",
      passcode: "-1",
      filter: "r/47/15/300",
    });
    is.on("down", () => {});
    is.start();
    await until(() => srv.lines.length === 1);
    expect(srv.lines[0]).toMatch(/ filter r\/47\/15\/300$/);
    is.setServiceCall("oe8apr-15");
    await until(() => srv.lines.length === 2);
    srv.close();
    expect(srv.lines[1]).toBe("#filter r/47/15/300 g/OE8APR-15");
  });
});

describe("APRS-IS uplink", () => {
  it("sends the service call's answers plain and a player's find as third-party traffic", async () => {
    const srv = await lineServer();
    const up = new AprsUplink({ host: "127.0.0.1", port: srv.port, serviceCall: "OE8APR-15", servicePass: "1234" });
    up.start();
    await until(() => srv.lines.length === 1);
    expect(up.publish({ src_call: "OE8APR-15", tocall: "APZACG", payload: ":OE5XYZ-7 :ack12" })).toBe(true);
    expect(up.publish({ src_call: "OE5XYZ-7", tocall: "APZACG", payload: ">Found AC-1234" })).toBe(true);
    await until(() => srv.lines.length === 3);
    srv.close();
    expect(srv.lines.slice(1)).toEqual([
      "OE8APR-15>APZACG,TCPIP*::OE5XYZ-7 :ack12",
      "OE8APR-15>APZACG,TCPIP*:}OE5XYZ-7>APZACG,TCPIP*:>Found AC-1234",
    ]);
  });
});

describe("APRS-IS uplink login", () => {
  it("logs the sysop's own box in as the service call with its feed passcode", () => {
    expect(uplinkLogin({ serviceCall: "OE8APR-15", feedCall: "OE8APR", feedPass: "12345" })).toEqual({
      call: "OE8APR-15",
      pass: "12345",
    });
  });
  it("prefers an explicit login", () => {
    expect(
      uplinkLogin({ serviceCall: "OE8APR-15", explicitCall: "oe8apr-5", explicitPass: "12345", feedCall: "N0CALL" }),
    ).toEqual({ call: "OE8APR-5", pass: "12345" });
  });
  it("publishes nothing from another operator's box, or without a passcode", () => {
    expect(uplinkLogin({ serviceCall: "OE8APR-15", feedCall: "OE5XYZ", feedPass: "12345" })).toHaveProperty("reason");
    expect(uplinkLogin({ serviceCall: "OE8APR-15", feedCall: "OE8APR", feedPass: "-1" })).toHaveProperty("reason");
    expect(uplinkLogin({ feedCall: "OE8APR", feedPass: "12345" })).toHaveProperty("reason");
  });
});
