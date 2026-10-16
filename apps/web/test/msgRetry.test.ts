// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser radio's message repeats: sent again until the station acks or rejects the message, only while the
// radio can transmit as the call it went out under, with the outcome reported to the instance.
import { describe, expect, it } from "vitest";
import { BrowserRetry, type RetryFrame } from "../src/rf/msgRetry.js";

function setup() {
  let t = 0;
  let can = true;
  const sent: RetryFrame[] = [];
  const reports: unknown[] = [];
  let changes = 0;
  const r = new BrowserRetry({
    now: () => t,
    canTransmit: (call) => can && call === "OE8APR-7",
    transmit: async (f) => {
      sent.push(f);
    },
    report: (m) => reports.push(m),
  });
  r.subscribe(() => changes++);
  const frame: RetryFrame = { src: "OE8APR-7", dst: "APRS", path: ["WIDE1-1"], payload: ":OE3ABC   :hi{42" };
  const run = (sec: number) => {
    for (let i = 0; i < sec; i += 5) {
      t += 5000;
      r.tick();
    }
  };
  return {
    r,
    sent,
    reports,
    frame,
    run,
    changes: () => changes,
    setCan: (v: boolean) => {
      can = v;
    },
  };
}

describe("browser message repeats", () => {
  it("repeats on the VHF schedule until the ack, then reports the tries", () => {
    const { r, sent, reports, frame, run, changes } = setup();
    r.track({ to: "OE3ABC", text: "hi", msgNo: "42", frame, feature: "Messages" });
    expect(r.getSnapshot()).toMatchObject({ waiting: 1, stats: { messages: 1 } });
    run(30);
    expect(sent).toEqual([frame]);
    run(60);
    expect(sent).toHaveLength(2);
    r.heard("OE3ABC", ":OE8APR-7 :ack42");
    expect(r.getSnapshot()).toMatchObject({ waiting: 0, stats: { acked: 1, retries: 2 } });
    expect(reports).toEqual([{ from: "OE8APR-7", to: "OE3ABC", text: "hi", msgNo: "42", tries: 3, outcome: "acked" }]);
    expect(changes()).toBeGreaterThan(2);
    run(600);
    expect(sent).toHaveLength(2);
  });

  it("a rej stops it, and an unanswered last try expires it", () => {
    const a = setup();
    a.r.track({ to: "OE3ABC", text: "hi", msgNo: "42", frame: a.frame, feature: "My radio" });
    a.r.heard("OE3ABC", ":OE8APR-7 :rej42");
    expect(a.reports).toMatchObject([{ outcome: "rejected", tries: 1 }]);

    const b = setup();
    b.r.track({ to: "OE3ABC", text: "hi", msgNo: "42", frame: b.frame, feature: "My radio" });
    b.run(30 + 60 + 120 + 240 + 480 + 5);
    expect(b.sent).toHaveLength(4);
    expect(b.reports).toMatchObject([{ outcome: "expired", tries: 5 }]);
  });

  it("stops when the radio can no longer transmit as the sender, and on stopAll", () => {
    const a = setup();
    a.r.track({ to: "OE3ABC", text: "hi", msgNo: "42", frame: a.frame, feature: "Messages" });
    a.setCan(false);
    a.run(30);
    expect(a.sent).toHaveLength(0);
    expect(a.reports).toMatchObject([{ outcome: "cancelled", tries: 1 }]);

    const b = setup();
    b.r.track({ to: "OE3ABC", text: "hi", msgNo: "42", frame: b.frame, feature: "Messages" });
    b.r.stopAll();
    expect(b.r.getSnapshot()).toMatchObject({ waiting: 0, stats: { cancelled: 1 } });
  });
});
