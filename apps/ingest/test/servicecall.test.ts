// SPDX-License-Identifier: AGPL-3.0-or-later
// The gateway's service call on APRS-IS: the feed asks for messages addressed to it, and the uplink sends the
// service call's own answers as plain packets, a player's announced find as third-party traffic.
import { describe, it, expect } from "vitest";
import net from "node:net";
import { AprsIs } from "../src/aprsis.js";
import { AprsUplink, parseLogresp, uplinkLogin } from "../src/uplink.js";
import { SOFTWARE_VERSION } from "../src/version.js";

/**
 * A TCP server that records every line it receives and answers a login with `# logresp`, as an APRS-IS
 * server does (`logresp: null` answers nothing).
 */
function lineServer(
  o: { logresp?: "verified" | "unverified" | null } = {},
): Promise<{ port: number; lines: string[]; connections: () => number; close: () => void }> {
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
          const line = buf.slice(0, i).replace(/\r$/, "");
          lines.push(line);
          buf = buf.slice(i + 1);
          const call = /^user (\S+)/.exec(line)?.[1];
          const answer = o.logresp === undefined ? "verified" : o.logresp;
          if (call && answer) s.write(`# logresp ${call} ${answer}, server T2TEST\r\n`);
        }
      });
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        lines,
        connections: () => socks.length,
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
    await until(() => up.verified);
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

describe("APRS-IS uplink verification", () => {
  it("logs in under the release version and publishes only once the server verifies the login", async () => {
    const srv = await lineServer({ logresp: null });
    const up = new AprsUplink({ host: "127.0.0.1", port: srv.port, serviceCall: "OE8APR-15", servicePass: "1234" });
    up.start();
    await until(() => srv.lines.length === 1);
    expect(srv.lines[0]).toBe(`user OE8APR-15 pass 1234 vers aprscaching ${SOFTWARE_VERSION}`);
    expect(SOFTWARE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(up.publish({ src_call: "OE8APR-15", tocall: "APZACG", payload: ">x" })).toBe(false);
    srv.close();
  });

  it("publishes nothing when the server answers the login as unverified", async () => {
    const srv = await lineServer({ logresp: "unverified" });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      const up = new AprsUplink({ host: "127.0.0.1", port: srv.port, serviceCall: "OE8APR-15", servicePass: "1" });
      up.start();
      await until(() => errors.length > 0);
      expect(up.verified).toBe(false);
      expect(up.publish({ src_call: "OE8APR-15", tocall: "APZACG", payload: ">x" })).toBe(false);
      expect(errors[0]).toMatch(/did not verify OE8APR-15/);
    } finally {
      console.error = orig;
      srv.close();
    }
  });

  it("reconnects when the server goes silent past the idle timeout", async () => {
    const srv = await lineServer();
    const up = new AprsUplink({
      host: "127.0.0.1",
      port: srv.port,
      serviceCall: "OE8APR-15",
      servicePass: "1234",
      idleMs: 50,
      retryMs: 10,
    });
    up.start();
    await until(() => srv.connections() >= 2);
    srv.close();
    expect(srv.connections()).toBeGreaterThanOrEqual(2);
  });

  it("reads the login answer", () => {
    expect(parseLogresp("# logresp OE8APR-15 verified, server T2AUSTRIA")).toEqual({
      call: "OE8APR-15",
      verified: true,
    });
    expect(parseLogresp("# logresp N0CALL unverified, server T2AUSTRIA")).toEqual({
      call: "N0CALL",
      verified: false,
    });
    expect(parseLogresp("# aprsc 2.1.19")).toBeNull();
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
