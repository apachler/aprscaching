// SPDX-License-Identifier: AGPL-3.0-or-later
// The radio command grammar, message-number handling, and the trust decision for a command message.
import { describe, it, expect } from "vitest";
import {
  parseRadioCommand,
  normalizeCacheCode,
  splitMessageNumber,
  isTrustedMessage,
  HELP_TEXT,
  foundText,
  type RadioMessage,
} from "../src/radiolog.js";
import type { FindScore } from "../src/caches.js";

describe("foundText", () => {
  const score = (verified: boolean, tier: "A" | "B" | "C") => ({ result: { verified, tier } }) as unknown as FindScore;

  it("names the tier the way the player sees it, never as a tier letter", () => {
    expect(foundText("AC-1234", score(true, "A"))).toBe("AC-1234 found, Radio-verified");
    expect(foundText("AC-1234", score(true, "B"))).toBe("AC-1234 found, Location-verified");
    expect(foundText("AC-1234", score(false, "B"))).toBe("AC-1234 found, logged, not verified");
    expect(foundText("AC-1234", score(true, "C"))).toBe("AC-1234 found, logged, not verified");
  });

  it("fits one APRS message", () => {
    expect(foundText("AC-ZZZZZZ", score(true, "B")).length).toBeLessThanOrEqual(67);
  });
});

describe("parseRadioCommand", () => {
  it("parses FOUND with and without log text", () => {
    expect(parseRadioCommand("FOUND AC-1234")).toEqual({ command: "found", code: "AC-1234" });
    expect(parseRadioCommand("found ac1234 nice spot, TFTC")).toEqual({
      command: "found",
      code: "AC-1234",
      body: "nice spot, TFTC",
    });
  });

  it("parses DNF, NOTE and HELP", () => {
    expect(parseRadioCommand("DNF AC-7 muggles")).toEqual({ command: "dnf", code: "AC-7", body: "muggles" });
    expect(parseRadioCommand("note ac-9 log is full")).toEqual({ command: "note", code: "AC-9", body: "log is full" });
    expect(parseRadioCommand("HELP")).toEqual({ command: "help" });
    expect(parseRadioCommand(" ? ")).toEqual({ command: "help" });
  });

  it("rejects malformed commands with a reason", () => {
    expect(parseRadioCommand("")).toHaveProperty("error");
    expect(parseRadioCommand("FOUND")).toEqual({ error: "FOUND needs a cache code, e.g. FOUND AC-1234" });
    expect(parseRadioCommand("FOUND 1234")).toHaveProperty("error");
    expect(parseRadioCommand("NOTE AC-1")).toEqual({ error: "NOTE needs a text" });
  });

  it("the HELP text fits one APRS message and carries no reserved or non-ASCII character", () => {
    expect(HELP_TEXT.length).toBeLessThanOrEqual(67);
    expect(HELP_TEXT).not.toMatch(/[|~{]/);
    expect(HELP_TEXT).toMatch(/^[\x20-\x7e]+$/);
  });

  it("error texts are plain ASCII", () => {
    expect(parseRadioCommand("HELLO")).toEqual({ error: "unknown command - send HELP" });
    expect(parseRadioCommand("")).toEqual({ error: "empty message - send HELP" });
  });
});

describe("normalizeCacheCode", () => {
  it("accepts the dash-less and lower-case forms", () => {
    expect(normalizeCacheCode("ac1234")).toBe("AC-1234");
    expect(normalizeCacheCode("AC-1234")).toBe("AC-1234");
    expect(normalizeCacheCode("AC_1234")).toBeNull();
    expect(normalizeCacheCode("1234")).toBeNull();
    expect(normalizeCacheCode("oe/st-001")).toBe("OE/ST-001");
    expect(normalizeCacheCode("OEFF-0123")).toBe("OEFF-0123");
    expect(normalizeCacheCode("OE/ST 001")).toBeNull();
    expect(normalizeCacheCode("OE/ST-001;DROP")).toBeNull();
  });
});

describe("splitMessageNumber", () => {
  it("keeps the decoder's message number", () => {
    expect(splitMessageNumber("FOUND AC-1", "12")).toEqual({ text: "FOUND AC-1", msgNo: "12" });
  });
  it("strips the reply-ack form the decoder leaves in the text", () => {
    expect(splitMessageNumber("FOUND AC-1{12}AB")).toEqual({ text: "FOUND AC-1", msgNo: "12" });
    expect(splitMessageNumber("FOUND AC-1{3}")).toEqual({ text: "FOUND AC-1", msgNo: "3" });
  });
  it("an unnumbered message has no number", () => {
    expect(splitMessageNumber("HELP")).toEqual({ text: "HELP" });
  });
  it("a number outside APRS101 (1-5 letters or digits) makes the message unnumbered", () => {
    expect(splitMessageNumber("HELP", "visit evil.example | now")).toEqual({ text: "HELP" });
    expect(splitMessageNumber("HELP", "123456")).toEqual({ text: "HELP" });
  });
});

describe("isTrustedMessage", () => {
  const sites = new Set(["OE8XXX-10"]);
  const msg = (o: Partial<RadioMessage>): RadioMessage => ({
    src: "OE8APR-7",
    text: "FOUND AC-1",
    ts: 1000,
    port: "kiss-tnc",
    heardVia: "rf",
    igateCall: "OE8XXX-10",
    path: ["WIDE1-1"],
    signed: false,
    ...o,
  });

  it("a message heard directly at an attested site is trusted", () => {
    expect(isTrustedMessage(msg({}), sites)).toBe(true);
  });
  it("an RF message gated by a site the operator does not attest is not", () => {
    expect(isTrustedMessage(msg({ igateCall: "DB0ZZZ-10" }), sites)).toBe(false);
  });
  it("an APRS-IS injection is not, whatever IGate it names", () => {
    expect(isTrustedMessage(msg({ heardVia: "aprs_is", path: ["TCPIP*", "qAC", "T2TEST"] }), sites)).toBe(false);
  });
  it("an APRS-IS message is not, even with a qAR path naming an attested site", () => {
    expect(
      isTrustedMessage(msg({ port: "aprs-is", path: ["WIDE1-1", "qAR", "OE8XXX-10"], igateCall: "OE8XXX-10" }), sites),
    ).toBe(false);
  });
  it("a direct MeshCom hearing at an attested node is trusted", () => {
    expect(isTrustedMessage(msg({ port: "meshcom" }), sites)).toBe(true);
  });
  it("a port the gateway does not know is not", () => {
    expect(isTrustedMessage(msg({ port: "something-new" }), sites)).toBe(false);
  });
  it("an internet-tunnelled port is not, whatever it claims", () => {
    expect(isTrustedMessage(msg({ port: "axudp" }), sites)).toBe(false);
  });
  it("a relayed MeshCom frame (RF, no receiving site) is not", () => {
    expect(isTrustedMessage(msg({ port: "meshcom", igateCall: null }), sites)).toBe(false);
  });
  it("with no attested sites nothing heard on the air is trusted", () => {
    expect(isTrustedMessage(msg({}), new Set())).toBe(false);
  });
  it("a batch signed by the sender's device key is trusted", () => {
    expect(isTrustedMessage(msg({ heardVia: "aprs_is", igateCall: null, signed: true }), new Set())).toBe(true);
  });
});
