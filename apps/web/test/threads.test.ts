// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { MailboxMessage, MessageItem } from "../src/api.js";
import {
  correspondents,
  isPersonMarker,
  nowRoute,
  sendBlocked,
  textMax,
  threadsOf,
  validRecipient,
} from "../src/messages/threads.js";

const msg = (id: number, ts: number, from: string, to: string | null, body: string, extra: Partial<MessageItem> = {}) =>
  ({ id, ts, fromCall: from, toCall: to, body, direction: "rx", ...extra }) as MessageItem;

const box = (id: number, from: string, to: string, status: MailboxMessage["status"], at: number): MailboxMessage => ({
  id,
  from,
  to,
  text: `box ${id}`,
  via: "app",
  status,
  deliveredTo: null,
  createdAt: at,
  expiresAt: at + 7 * 86400,
  deliveredAt: null,
  attempts: 0,
});

describe("conversations", () => {
  it("pairs the operator (any SSID) with each other station, newest conversation first, oldest message first", () => {
    const t = threadsOf(
      [
        msg(1, 100, "OE5XYZ-7", "OE8APR-7", "hi"),
        msg(2, 110, "OE8APR-9", "OE5XYZ-7", "hello", { direction: "tx", delivery: "acked" }),
        msg(3, 200, "DL1ABC", "OE8APR", "servus"),
        msg(4, 300, "OE1AAA", "OE2BBB", "not mine"),
      ],
      undefined,
      "OE8APR-7",
      "OE8APR-15",
    );
    expect(t.map((x) => x.peer)).toEqual(["DL1ABC", "OE5XYZ-7"]);
    const xyz = t[1]!;
    expect(xyz.items.map((i) => [i.dir, i.text, i.state])).toEqual([
      ["in", "hi", undefined],
      ["out", "hello", "acked"],
    ]);
    expect(correspondents(t)).toEqual(["DL1ABC", "OE5XYZ-7"]);
  });

  it("never counts the service call's side as the operator's, and files a delivered Mailbox message under its sender", () => {
    const t = threadsOf(
      [
        msg(1, 100, "OE8APR-15", "OE8APR-7", "de OE6XRR-9: see you at the field day"),
        msg(2, 120, "OE8APR-15", "OE1AAA", "an answer to someone else"),
      ],
      undefined,
      "OE8APR",
      "OE8APR-15",
    );
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ peer: "OE6XRR-9" });
    expect(t[0]!.items[0]).toMatchObject({ dir: "in", text: "see you at the field day", viaMailbox: true });
  });

  it("folds in the Mailbox: what the operator left, with its state, and what waits for them until it is sent", () => {
    const t = threadsOf(
      [],
      {
        sent: [
          box(1, "OE8APR-7", "OE6XRR", "held", 50),
          { ...box(2, "OE8APR-7", "OE5XYZ", "delivered", 40), deliveredTo: "OE5XYZ-9" },
          { ...box(5, "OE8APR-7", "DL2SNT", "sent", 45), deliveredTo: "DL2SNT-7" },
        ],
        received: [box(3, "OE6XRR-9", "OE8APR", "held", 60), box(4, "DL1ABC", "OE8APR", "sent", 70)],
      },
      "OE8APR-7",
      null,
    );
    const by = Object.fromEntries(t.map((x) => [x.peer, x.items]));
    expect(by["OE6XRR"]).toEqual([expect.objectContaining({ dir: "out", state: "waiting", withdrawId: 1 })]);
    expect(by["OE5XYZ-9"]).toEqual([expect.objectContaining({ dir: "out", state: "delivered" })]);
    expect(by["OE5XYZ-9"]![0]!.withdrawId).toBeUndefined();
    // one already sent on the air can no longer be taken back
    expect(by["DL2SNT-7"]).toEqual([expect.objectContaining({ dir: "out", state: "sent-no-ack" })]);
    expect(by["DL2SNT-7"]![0]!.withdrawId).toBeUndefined();
    expect(by["OE6XRR-9"]).toEqual([expect.objectContaining({ dir: "in", state: "waiting" })]);
    // one already sent on the air arrives as the service call delivered it
    expect(by["DL1ABC"]).toBeUndefined();
  });
});

describe("how a new message is delivered", () => {
  it("goes from the operator's own radio only with a TNC that can transmit and transmit switched on", () => {
    expect(nowRoute({ link: "serial", txOn: true, verified: true })).toBe("radio");
    expect(nowRoute({ link: "ble", txOn: true, verified: true })).toBe("radio");
    expect(nowRoute({ link: "serial", txOn: false, verified: true })).toBe("instance");
    expect(nowRoute({ link: "audio", txOn: true, verified: true })).toBe("instance");
    expect(nowRoute({ link: "mesh", txOn: true, verified: true })).toBe("instance");
    expect(nowRoute({ link: null, txOn: true, verified: true })).toBe("instance");
    expect(nowRoute({ link: "serial", txOn: true, verified: false })).toBe("instance");
  });

  it("is locked, with the reason, until the callsign is verified", () => {
    expect(sendBlocked({ signedIn: false, verified: false, callsign: "" })).toMatch(/Sign in/);
    expect(sendBlocked({ signedIn: true, verified: false, callsign: "OE8APR-7" })).toMatch(/Verify OE8APR/);
    expect(sendBlocked({ signedIn: true, verified: true, callsign: "OE8APR-7" })).toBeNull();
  });

  it("keeps the text within an APRS message, the Mailbox's prefix included", () => {
    expect(textMax("now", "OE8APR-7")).toBe(67);
    expect(textMax("heard", "OE8APR-7")).toBe(67 - "de OE8APR-7: ".length);
  });

  it("takes a callsign with an optional SSID as the recipient", () => {
    expect(validRecipient("oe5xyz-7")).toBe(true);
    expect(validRecipient("OE5XYZ")).toBe(true);
    expect(validRecipient("OE5XYZ-123")).toBe(false);
    expect(validRecipient("")).toBe(false);
    expect(validRecipient("FORMER")).toBe(false);
  });

  it("marks the conversation with erased people and former holders as withdrawn, never a reply target", () => {
    const t = threadsOf(
      [
        msg(1, 100, "WITHDRAWN", "OE8APR", "from someone who left"),
        msg(2, 200, "FORMER", "OE8APR", "from a call's former holder"),
        msg(3, 300, "DL1ABC", "OE8APR", "servus"),
      ],
      undefined,
      "OE8APR",
      null,
    );
    expect(t.map((x) => [x.peer, x.withdrawn ?? false])).toEqual([
      ["DL1ABC", false],
      ["FORMER", true],
      ["WITHDRAWN", true],
    ]);
    expect(correspondents(t)).toEqual(["DL1ABC"]);
    expect(isPersonMarker("withdrawn#abc")).toBe(true);
    expect(isPersonMarker("OE5XYZ")).toBe(false);
  });
});
