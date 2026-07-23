// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  rigctldSetFreq,
  rigctldGetFreq,
  rigctldSetMode,
  rigctldSetPtt,
  rigctldDumpState,
  parseRprt,
  parseFreqReply,
  parseModeReply,
  RigctldClient,
  type RigctldTransport,
} from "../src/index.js";

describe("Hamlib rigctld client", () => {
  it("builds the wire command lines", () => {
    expect(rigctldSetFreq(14_074_000)).toBe("F 14074000\n");
    expect(rigctldGetFreq()).toBe("f\n");
    expect(rigctldSetMode("usb", 2400)).toBe("M USB 2400\n");
    expect(rigctldSetPtt(true)).toBe("T 1\n");
    expect(rigctldSetPtt(false)).toBe("T 0\n");
    expect(rigctldDumpState()).toBe("\\dump_state\n");
  });

  it("parses RPRT set-replies (0 = ok, negative = error)", () => {
    expect(parseRprt("RPRT 0\n")).toEqual({ ok: true, code: 0 });
    expect(parseRprt("RPRT -1\n")).toEqual({ ok: false, code: -1 });
    expect(parseRprt("garbage").ok).toBe(false);
  });

  it("parses get-frequency + get-mode replies, rejecting error replies", () => {
    expect(parseFreqReply("14074000\n")).toBe(14_074_000);
    expect(parseFreqReply("RPRT -1\n")).toBeNull();
    expect(parseFreqReply("nonsense")).toBeNull();
    expect(parseModeReply("USB\n2400\n")).toEqual({ mode: "USB", passbandHz: 2400 });
    expect(parseModeReply("RPRT -1")).toBeNull();
  });

  it("drives a rig through an injected transport (the two-backends-one-API shape)", async () => {
    const sent: string[] = [];
    const tx: RigctldTransport = {
      async send(line) {
        sent.push(line);
        if (line === "f\n") return "14074000\n";
        if (line === "m\n") return "USB\n2400\n";
        if (line === "t\n") return "1\n";
        return "RPRT 0\n"; // every set succeeds
      },
    };
    const rig = new RigctldClient(tx);
    expect((await rig.setFrequency(14_074_000)).ok).toBe(true);
    expect(await rig.getFrequency()).toBe(14_074_000);
    expect(await rig.getMode()).toEqual({ mode: "USB", passbandHz: 2400 });
    expect((await rig.setPtt(true)).ok).toBe(true);
    expect(await rig.getPtt()).toBe(true);
    expect(sent).toEqual(["F 14074000\n", "f\n", "m\n", "T 1\n", "t\n"]);
  });
});
