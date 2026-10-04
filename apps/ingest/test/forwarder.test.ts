// SPDX-License-Identifier: AGPL-3.0-or-later
// A forwarding session whose connect script fails at a later hop releases the link it opened to the first
// hop: the pipe subscription is removed and the first hop sees a DISC.
import { describe, it, expect } from "vitest";
import { ConnectedLink, decodeFrame, encodeFrame, parseAddr, type Ax25Frame } from "@aprscaching/ax25";
import { frameForwardLink } from "../src/forwarder.js";
import type { FrameLink } from "../src/link.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A frame pipe whose far end is a NET/ROM node that answers every `C <call>` with `reply`. */
function nodePipe(reply: string) {
  const subs = new Set<(b: Uint8Array) => void>();
  const seen: Ax25Frame["type"][] = [];
  const node: ConnectedLink = new ConnectedLink(parseAddr("NODE1"), parseAddr("OE8BBS"), {
    send: (f) => {
      const bytes = encodeFrame(f);
      queueMicrotask(() => {
        for (const s of subs) s(bytes);
      });
    },
    deliver: (info) => {
      if (dec(info).startsWith("C ")) node.send(enc(`${reply}\r`));
    },
    state: () => {},
    error: () => {},
  });
  const pipe: FrameLink = {
    sendFrame: (f) => {
      const g = decodeFrame(encodeFrame(f))!;
      seen.push(g.type);
      queueMicrotask(() => node.onReceive(g));
      return true;
    },
    onRaw: (cb) => void subs.add(cb),
    offRaw: (cb) => void subs.delete(cb),
  };
  return { pipe, subs, seen };
}

describe("frameForwardLink", () => {
  it("releases the first hop's link when a later hop of the connect script fails", async () => {
    const { pipe, subs, seen } = nodePipe("*** failure with DB0XYZ: busy");
    const link = frameForwardLink(pipe, {
      mycall: "OE8BBS",
      partnerCall: "DB0XYZ",
      connectScript: "C NODE1\nC DB0XYZ",
    });
    expect(subs.size).toBe(1);
    await expect(link.connect()).rejects.toThrow(/connect script failed/);
    expect(seen).toContain("DISC");
    await sleep(600); // DISC has its moment on air, then the subscription goes
    expect(subs.size).toBe(0);
  });

  it("is ready once every hop of the connect script confirms", async () => {
    const { pipe, subs } = nodePipe("*** connected to DB0XYZ");
    const link = frameForwardLink(pipe, {
      mycall: "OE8BBS",
      partnerCall: "DB0XYZ",
      connectScript: "C NODE1\nC DB0XYZ",
    });
    await expect(link.connect()).resolves.toBeUndefined();
    expect(subs.size).toBe(1);
    link.disconnect();
    await sleep(600);
    expect(subs.size).toBe(0);
  });
});
