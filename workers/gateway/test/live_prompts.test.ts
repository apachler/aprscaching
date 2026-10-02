// SPDX-License-Identifier: AGPL-3.0-or-later
// A geofence prompt goes to the person: a subscriber signed in with a base call gets the prompt a beacon
// from any of its SSIDs raised, and nobody else does.
import { describe, it, expect } from "vitest";
import { deliveriesFor, type LiveEnvelope } from "../src/live.js";
import type { Subscribe } from "@aprscaching/shared";

const prompt = { type: "near_cache", cacheId: 1, code: "AC-0001", title: "oak", distanceM: 40 } as const;
const env = (forCallsign: string): LiveEnvelope => ({ prompts: [{ forCallsign, prompt }] });
const sub = (callsign: string) => ({ type: "subscribe", bbox: [0, 0, 1, 1], callsign }) as unknown as Subscribe;

describe("geofence prompts", () => {
  it("reach the subscriber from a beacon of any of its SSIDs", () => {
    expect(deliveriesFor(sub("OE8APR"), env("OE8APR-7"))).toEqual([prompt]);
    expect(deliveriesFor(sub("oe8apr-9"), env("OE8APR"))).toEqual([prompt]);
  });
  it("never reach another callsign", () => {
    expect(deliveriesFor(sub("OE8APX"), env("OE8APR-7"))).toEqual([]);
    expect(deliveriesFor(sub("OE8AP"), env("OE8APR"))).toEqual([]);
  });
});
