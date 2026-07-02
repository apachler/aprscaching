import { describe, it, expect } from "vitest";
import {
  aprsPasscode, thirdPartyEncap, localEvent, ackReply, messageForMe, syncBackBatch,
  decodeAprs, type ParsedFrame,
} from "../src/index.js";

describe("APRS-IS passcode (docs/19)", () => {
  it("is the public hash, SSID-independent, and never authorization", () => {
    expect(aprsPasscode("N0CALL")).toBe(13023);          // widely-cited reference vector
    expect(aprsPasscode("N0CALL-9")).toBe(aprsPasscode("N0CALL")); // base call only
    expect(aprsPasscode("n0call")).toBe(13023);          // case-insensitive
    expect(aprsPasscode("APRS")).toBeTypeOf("number");
  });
});

describe("third-party encapsulation (path A, docs/19 P3)", () => {
  it("wraps the user's info under the peer's login with a leading }", () => {
    const line = thirdPartyEncap({ gateCall: "OE8APR-10", userCall: "OE3ABC-7", info: ":OE1XYZ   :hi{1", dst: "APAC01" });
    expect(line).toBe("OE8APR-10>APRS,TCPIP*:}OE3ABC-7>APAC01,TCPIP*::OE1XYZ   :hi{1");
    expect(line).toContain("}OE3ABC-7>");                // inner source is the USER
  });
});

// helper: parse a raw TNC2 line into { frame, data }
function parse(raw: string) {
  const [head, ...rest] = raw.split(":");
  const payload = rest.join(":");
  const m = /^([^>]+)>([^,]+)(?:,(.*))?$/.exec(head!)!;
  const frame: ParsedFrame = { src: m[1]!, dst: m[2]!, path: m[3] ? m[3].split(",") : [], payload, raw };
  return { frame, data: decodeAprs(frame) };
}

describe("field-station local events (docs/16 A)", () => {
  it("maps a position frame to a local station", () => {
    const { frame, data } = parse("OE8XBM-7>APRS,WIDE1-1:!4703.55N/01527.30E>heading home");
    const ev = localEvent(frame, data, 1000);
    expect(ev.kind).toBe("station");
    if (ev.kind === "station") {
      expect(ev.station.callsign).toBe("OE8XBM-7");
      expect(ev.station.lat).toBeCloseTo(47.059, 2);
      expect(ev.station.comment).toContain("heading home");
      expect(ev.station.heardAt).toBe(1000);
    }
  });

  it("maps a message frame to a local inbox message + builds an ACK for us", () => {
    const { frame, data } = parse("OE3ABC-7>APRS,WIDE1-1::OE8APR-9 :ping{42");
    const ev = localEvent(frame, data, 2000);
    expect(ev.kind).toBe("message");
    if (ev.kind === "message") {
      expect(ev.message.from).toBe("OE3ABC-7");
      expect(ev.message.to).toBe("OE8APR-9");
      expect(ev.message.text).toBe("ping");
      expect(messageForMe(ev.message, "OE8APR")).toBe(true);       // base-call match, SSID-agnostic
      expect(ackReply(ev.message, "OE8APR")).toBe(":OE3ABC-7 :ack42");
      expect(ackReply(ev.message, "OE1ZZZ")).toBeNull();           // not for us
    }
  });

  it("does not ACK an ack, and ignores non-position/non-message frames", () => {
    const { frame, data } = parse("OE3ABC-7>APRS::OE8APR-9 :ack42");
    const ev = localEvent(frame, data, 3000);
    if (ev.kind === "message") expect(ackReply(ev.message, "OE8APR")).toBeNull();  // acking an ack → null
    const status = parse("OE8APR-7>APRS:>just a status");
    expect(localEvent(status.frame, status.data, 4000).kind).toBe("none");
  });
});

describe("sync-back batching (docs/16 D)", () => {
  it("dedupes, drops our own frames, and caps", () => {
    const heard = [
      { raw: "OE1AAA>APRS:!x", at: 1 },
      { raw: "OE1AAA>APRS:!x", at: 2 },     // dup
      { raw: "OE8APR-7>APRS:!mine", at: 3 }, // our own → dropped
      { raw: "OE2BBB>APRS:!y", at: 4 },
    ];
    const out = syncBackBatch(heard, "OE8APR", 10);
    expect(out.map((h) => h.raw)).toEqual(["OE1AAA>APRS:!x", "OE2BBB>APRS:!y"]);
    expect(syncBackBatch(heard, "OE8APR", 1)).toHaveLength(1);   // cap honored
  });
});
