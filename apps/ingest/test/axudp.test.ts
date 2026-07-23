// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import dgram from "node:dgram";
import { encodeFrame, decodeFrame, parseAddr, type Ax25Frame } from "@aprscaching/ax25";
import {
  AxudpPort,
  axudpToPacket,
  parseAxudpPeers,
  frameToAxudp,
  crc16X25,
  appendAxipCrc,
  stripAxipCrc,
} from "../src/axudp.js";

/** A bare AX.25 UI/APRS frame — exactly what an AXUDP datagram (BPQ mesh, UDP 10093) carries. */
function axudpDatagram(src: string, dst: string, aprs: string): Uint8Array {
  return encodeFrame({
    dst: parseAddr(dst),
    src: parseAddr(src),
    command: true,
    type: "UI",
    pf: false,
    pid: 0xf0,
    info: new TextEncoder().encode(aprs),
  });
}

describe("AXUDP ingest normalize", () => {
  it("decodes a tunnelled AX.25 frame into a Packet", () => {
    const p = axudpToPacket(axudpDatagram("OE8APR-9", "APRS", "!4703.00N/01526.00E>test"), 1000)!;
    expect(p).not.toBeNull();
    expect(p.src).toBe("OE8APR-9");
    expect(p.payload).toBe("!4703.00N/01526.00E>test");
    expect(p.ts).toBe(1000);
  });

  it("lands the frame at Tier C and can NEVER be first-party attested (transport != trust)", () => {
    const p = axudpToPacket(axudpDatagram("DL1ABC", "APRS", ">just a status"), 1000)!;
    // heardVia:aprs_is + port:axudp + no qAR in the path → the gateway's provenance derivation gives
    // firstPartyAttested = false. This is the invariant the reserved seam must never regress.
    expect(p.heardVia).toBe("aprs_is");
    expect(p.port).toBe("axudp");
    expect((p.path ?? []).some((h) => /^qAR$/i.test(h))).toBe(false);
  });

  it("returns null for an undecodable datagram", () => {
    expect(axudpToPacket(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("parses a peer spec, defaulting to the AXUDP port 10093", () => {
    expect(parseAxudpPeers("db0xyz.example:10093, 44.1.2.3")).toEqual([
      { host: "db0xyz.example", port: 10093 },
      { host: "44.1.2.3", port: 10093 },
    ]);
  });

  it("TX: frameToAxudp encodes a frame that decodes back through the RX path (round-trip)", () => {
    const f = {
      dst: parseAddr("OE8XBM-7"),
      src: parseAddr("OE8APR-9"),
      command: true,
      type: "UI" as const,
      pf: false,
      pid: 0xf0,
      info: new TextEncoder().encode("egress"),
    };
    const datagram = frameToAxudp(f);
    // egress carries the RFC 1226 CRC trailer — a peer (BPQAXIP/ax25ipd) validates + strips it…
    const back = decodeFrame(stripAxipCrc(datagram))!;
    expect(back.src).toEqual(f.src);
    expect(back.dst).toEqual(f.dst);
    // …and our own RX normalizer strips it too, landing the frame at Tier C on the axudp port.
    const p = axudpToPacket(datagram, 1000)!;
    expect(p.src).toBe("OE8APR-9");
    expect(p.payload).toBe("egress");
    expect(p.port).toBe("axudp");
  });
});

describe("AXIP/AXUDP CRC trailer (RFC 1226 / BPQAXIP / ax25ipd)", () => {
  it("crc16X25 matches the known check value ('123456789' -> 0x906E)", () => {
    expect(crc16X25(new TextEncoder().encode("123456789"))).toBe(0x906e);
  });

  it("TX datagrams end with the CRC of the frame, low byte first", () => {
    const frame = axudpDatagram("OE1ACS-7", "NODES", "x");
    const withCrc = appendAxipCrc(frame);
    expect(withCrc.length).toBe(frame.length + 2);
    const crc = crc16X25(frame);
    expect(withCrc[frame.length]).toBe(crc & 0xff);
    expect(withCrc[frame.length + 1]).toBe(crc >>> 8);
  });

  it("RX validates + strips a trailered datagram (what BPQAXIP sends)", () => {
    const frame = axudpDatagram("GB7BPQ-7", "NODES", "n");
    expect(Array.from(stripAxipCrc(appendAxipCrc(frame)))).toEqual(Array.from(frame));
  });

  it("RX passes a bare frame through unchanged (trailer-less peers stay decodable)", () => {
    const frame = axudpDatagram("OE8APR-9", "APRS", ">bare");
    expect(Array.from(stripAxipCrc(frame))).toEqual(Array.from(frame));
    // and the ingest normalizer still accepts it end-to-end
    expect(axudpToPacket(frame, 1000)!.src).toBe("OE8APR-9");
  });

  it("RX rejects a datagram whose trailer is corrupted (leaves it bare → decode judges it)", () => {
    const withCrc = appendAxipCrc(axudpDatagram("OE8APR-9", "APRS", ">x"));
    withCrc[withCrc.length - 1] = withCrc[withCrc.length - 1]! ^ 0xff;
    // the corrupt trailer no longer verifies, so nothing is stripped
    expect(stripAxipCrc(withCrc).length).toBe(withCrc.length);
  });
});

// The socket seam NET/ROM + the FBB forwarder ride: TX datagrams carry the trailer on the wire,
// RX hands STRIPPED bare frames to the connected-mode consumers — for a trailered peer (BPQAXIP,
// ax25ipd) and a bare-frame peer alike.
describe("AxudpPort over a real UDP socket", () => {
  const uiFrame = (info: string): Ax25Frame => ({
    dst: parseAddr("NODES"),
    src: parseAddr("GB7BPQ-7"),
    command: true,
    type: "UI",
    pf: false,
    pid: 0xf0,
    info: new TextEncoder().encode(info),
  });
  /** Bind a throwaway UDP socket on 127.0.0.1 and resolve its ephemeral port. */
  const bindPeer = (): Promise<{ sock: dgram.Socket; port: number }> =>
    new Promise((resolve) => {
      const sock = dgram.createSocket("udp4");
      sock.bind(0, "127.0.0.1", () => resolve({ sock, port: sock.address().port }));
    });
  const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  };

  it("TX puts frame + valid CRC trailer on the wire; a raw peer verifies it", async () => {
    const { sock: peer, port: peerPort } = await bindPeer();
    const got: Buffer[] = [];
    peer.on("message", (m) => got.push(m));
    const port = new AxudpPort({ port: 0, bind: "127.0.0.1", peers: [{ host: "127.0.0.1", port: peerPort }] });
    port.start();
    await new Promise((r) => setTimeout(r, 50)); // let the bind settle before the first send
    const f = uiFrame("wire-tx");
    port.sendFrame(f);
    await waitFor(() => got.length > 0);
    port.stop();
    peer.close();
    expect(got.length).toBeGreaterThan(0);
    const datagram = Uint8Array.from(got[0]!);
    const bare = stripAxipCrc(datagram);
    expect(bare.length).toBe(datagram.length - 2); // the trailer verified and was stripped
    expect(decodeFrame(bare)!.src).toEqual(f.src);
  });

  it("RX strips a trailered datagram (BPQAXIP/ax25ipd peer) before onRaw/onFrame/onPacket", async () => {
    const packets: string[] = [];
    const rawLens: number[] = [];
    const frames: string[] = [];
    const port = new AxudpPort({ port: 0, bind: "127.0.0.1", peers: [] }, (p) => packets.push(p.src));
    port.onRaw((b) => rawLens.push(b.length));
    port.onFrame((f) => frames.push(f.src.call));
    port.start();
    await new Promise((r) => setTimeout(r, 50));
    const bound = (port as unknown as { sock: dgram.Socket }).sock.address().port;
    const { sock: peer } = await bindPeer();
    const bare = encodeFrame(uiFrame(">trailered"));
    peer.send(appendAxipCrc(bare), bound, "127.0.0.1");
    await waitFor(() => frames.length > 0);
    port.stop();
    peer.close();
    expect(rawLens[0]).toBe(bare.length); // trailer gone before consumers see the frame
    expect(frames[0]).toBe("GB7BPQ");
    expect(packets[0]).toBe("GB7BPQ-7"); // Tier-C ingest fed too
  });

  it("RX still decodes a bare-frame peer (no trailer) unchanged", async () => {
    const frames: string[] = [];
    const port = new AxudpPort({ port: 0, bind: "127.0.0.1", peers: [] });
    port.onFrame((f) => frames.push(f.src.call));
    port.start();
    await new Promise((r) => setTimeout(r, 50));
    const bound = (port as unknown as { sock: dgram.Socket }).sock.address().port;
    const { sock: peer } = await bindPeer();
    peer.send(encodeFrame(uiFrame(">bare")), bound, "127.0.0.1");
    await waitFor(() => frames.length > 0);
    port.stop();
    peer.close();
    expect(frames[0]).toBe("GB7BPQ");
  });

  it("two AxudpPorts round-trip a frame end-to-end (both ends of our own bridge)", async () => {
    const rx = new AxudpPort({ port: 0, bind: "127.0.0.1", peers: [] });
    const frames: string[] = [];
    rx.onFrame((f) => frames.push(new TextDecoder().decode(f.info ?? new Uint8Array())));
    rx.start();
    await new Promise((r) => setTimeout(r, 50));
    const rxPort = (rx as unknown as { sock: dgram.Socket }).sock.address().port;
    const tx = new AxudpPort({ port: 0, bind: "127.0.0.1", peers: [{ host: "127.0.0.1", port: rxPort }] });
    tx.start();
    await new Promise((r) => setTimeout(r, 50));
    tx.sendFrame(uiFrame("loop"));
    await waitFor(() => frames.length > 0);
    tx.stop();
    rx.stop();
    expect(frames[0]).toBe("loop");
  });
});
