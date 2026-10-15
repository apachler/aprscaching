// SPDX-License-Identifier: AGPL-3.0-or-later
// Each port's health: frames heard, the ones whose APRS payload decodes, invalid frames, and the rate over the
// last minute; a report's counts are taken only once committed, so a failed POST loses none.
import { describe, expect, it } from "vitest";
import type { Packet } from "@aprscaching/shared";
import { PortHealthCounter, RATE_WINDOW_S } from "../src/porthealth.js";

const pkt = (payload: string, port = "kiss-tnc"): Packet => ({
  src: "OE8APR-9",
  dst: "APRS",
  path: [],
  payload,
  kind: "other",
  heardVia: "rf",
  port,
  ts: 0,
});

describe("PortHealthCounter", () => {
  it("counts heard, parsed and invalid frames per port", () => {
    let now = 1_000_000;
    const h = new PortHealthCounter(() => now);
    h.packet(pkt("!4703.50N/01530.00E>"));
    h.packet(pkt("some text that is no APRS"));
    h.invalid("kiss-tnc");
    h.packet(pkt(">status", "aprs-is"));
    now += 1000;
    const r = h.report();
    expect(r.ports).toEqual([
      { port: "kiss-tnc", heard: 3, parsed: 1, invalid: 1, pps: Math.round((3 / RATE_WINDOW_S) * 100) / 100 },
      { port: "aprs-is", heard: 1, parsed: 1, invalid: 0, pps: Math.round((1 / RATE_WINDOW_S) * 100) / 100 },
    ]);
  });

  it("reports the counts again until the gateway took them", () => {
    const h = new PortHealthCounter(() => 0);
    expect(h.size).toBe(0);
    h.packet(pkt("!4703.50N/01530.00E>"));
    expect(h.size).toBe(1);
    h.report(); // the POST failed: nothing committed
    const r = h.report();
    expect(r.ports[0]).toMatchObject({ heard: 1, parsed: 1 });
    h.packet(pkt("!4703.50N/01530.00E>")); // heard while the POST was in flight
    r.commit();
    expect(h.report().ports[0]).toMatchObject({ heard: 1, parsed: 1, invalid: 0 });
    h.report().commit();
    expect(h.report().ports[0]).toMatchObject({ heard: 0, parsed: 0, invalid: 0 });
  });

  it("drops frames older than the rate window from the rate", () => {
    let now = 5_000_000;
    const h = new PortHealthCounter(() => now);
    for (let i = 0; i < 30; i++) h.packet(pkt("!4703.50N/01530.00E>"));
    expect(h.report().ports[0]!.pps).toBe(0.5);
    now += (RATE_WINDOW_S + 1) * 1000;
    expect(h.report().ports[0]!.pps).toBe(0);
  });
});
