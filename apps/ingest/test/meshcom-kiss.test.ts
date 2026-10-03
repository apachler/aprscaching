// SPDX-License-Identifier: AGPL-3.0-or-later
// The MeshCom node's KISS port: the box sends only after the password handshake, only from calls of the
// node's base call, reads the node's verdict on each frame, and passes on acks to the service call.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { encodeAx25, kissWrap, kissDecode, decodeAx25 } from "@aprscaching/aprs";
import { MeshcomKiss } from "../src/meshcom-kiss.js";

const PASS = "s3cret";
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

/** A fake node: optional password challenge, a TX result for each frame, and frames it can push. */
async function fakeNode(o: { auth: boolean; result?: number }) {
  const got: string[] = [];
  let client: net.Socket | undefined;
  const srv = net.createServer((s) => {
    client = s;
    let authed = !o.auth;
    const nonce = randomBytes(16);
    if (o.auth) s.write(`NONCE: ${nonce.toString("hex")}\r\n`);
    let text = "";
    s.on("data", (c: Buffer) => {
      if (!authed) {
        text += c.toString("latin1");
        const line = text.split("\r\n")[0]!;
        if (!text.includes("\r\n")) return;
        authed = line === createHmac("sha256", PASS).update(nonce).digest("hex");
        s.write(authed ? "OK\r\n" : "FAIL\r\n");
        return;
      }
      for (const k of kissDecode(Uint8Array.from(c))) {
        const f = decodeAx25(k.frame);
        if (f) got.push(`${f.src}:${f.payload}`);
        s.write(Buffer.from([0xc0, 0xf0, o.result ?? 1, 1, 0, 0, 0, 0xc0]));
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: (srv.address() as net.AddressInfo).port,
    got,
    push: (f: { src: string; dst: string; path: string[]; payload: string }) => client?.write(kissWrap(encodeAx25(f))),
    close: () => {
      client?.destroy();
      srv.close();
    },
  };
}

const quiet = { log: () => {}, error: () => {} };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("MeshCom KISS link", () => {
  it("sends from the service call after the handshake, and reads the node's verdict", async () => {
    const node = await fakeNode({ auth: true });
    const k = new MeshcomKiss(
      { host: "127.0.0.1", port: node.port, password: PASS, nodeCall: "OE8APR-12", log: quiet },
      () => {},
    );
    cleanups.push(() => (k.stop(), node.close()));
    k.start();
    await until(() => k.canSend("OE8APR-15"));
    expect(k.canSend("OE8APR-15")).toBe(true);
    expect(k.canSend("OE5XYZ")).toBe(false); // another base call: the node would refuse it
    expect(await k.send("OE8APR-15", ":OE5XYZ-7 :de OE1ABC: hi{1A")).toBe("queued");
    expect(node.got).toEqual(["OE8APR-15::OE5XYZ-7 :de OE1ABC: hi{1A"]);
  });

  it("passes on an ack a station sent to the service call, and nothing else", async () => {
    const node = await fakeNode({ auth: true });
    const acks: string[] = [];
    const k = new MeshcomKiss(
      { host: "127.0.0.1", port: node.port, password: PASS, nodeCall: "OE8APR-12", log: quiet },
      (from, no) => acks.push(`${from} ${no}`),
    );
    cleanups.push(() => (k.stop(), node.close()));
    k.setServiceCall("OE8APR-15");
    k.start();
    await until(() => k.canSend("OE8APR-15"));
    node.push({ src: "OE5XYZ-7", dst: "APRSMC", path: [], payload: ":OE1ABC   :ack3" });
    node.push({ src: "OE5XYZ-7", dst: "APRSMC", path: [], payload: ":OE8APR-15:hello" });
    node.push({ src: "OE5XYZ-7", dst: "APRSMC", path: [], payload: ":OE8APR-15:ack1A" });
    await until(() => acks.length > 0);
    expect(acks).toEqual(["OE5XYZ-7 1A"]);
  });

  it("never sends through a node without a password, or with a wrong one", async () => {
    for (const [auth, password] of [
      [false, PASS],
      [true, "wrong"],
    ] as const) {
      const node = await fakeNode({ auth });
      const errors: string[] = [];
      const k = new MeshcomKiss(
        {
          host: "127.0.0.1",
          port: node.port,
          password,
          nodeCall: "OE8APR-12",
          authWaitMs: 200,
          log: { log: () => {}, error: (m: string) => errors.push(m) },
        },
        () => {},
      );
      cleanups.push(() => (k.stop(), node.close()));
      k.start();
      await until(() => errors.length > 0);
      expect(k.canSend("OE8APR-15")).toBe(false);
      expect(errors[0]).toMatch(/--kiss auth on/);
    }
  });
});
