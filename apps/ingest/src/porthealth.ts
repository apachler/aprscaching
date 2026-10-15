// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * porthealth.ts — each port's health, the figures a feed viewer shows: frames heard, the share whose APRS
 * payload decodes, frames that were not a packet at all, and packets per second over the last minute. Counted
 * in memory and carried to the gateway with the next batch; a report is committed only once the gateway took
 * it, so a failed POST loses no counts.
 */
import { decodeAprs } from "@aprscaching/aprs";
import type { Packet, PortHealth } from "@aprscaching/shared";
import { PORT_HEALTH_MAX } from "@aprscaching/shared";

/** The rate window, seconds. */
export const RATE_WINDOW_S = 60;

interface Counts {
  heard: number;
  parsed: number;
  invalid: number;
  /** The totals the gateway already took. */
  sent: { heard: number; parsed: number; invalid: number };
  /** Frames per second of the window, a ring indexed by the second modulo its length. */
  ring: number[];
  /** The second each ring slot counts. */
  ringSec: number[];
}

export class PortHealthCounter {
  private ports = new Map<string, Counts>();

  constructor(private now: () => number = Date.now) {}

  private of(port: string): Counts | undefined {
    let c = this.ports.get(port);
    if (!c) {
      if (this.ports.size >= PORT_HEALTH_MAX) return undefined; // a bounded report: the gateway takes no more
      c = {
        heard: 0,
        parsed: 0,
        invalid: 0,
        sent: { heard: 0, parsed: 0, invalid: 0 },
        ring: new Array<number>(RATE_WINDOW_S).fill(0),
        ringSec: new Array<number>(RATE_WINDOW_S).fill(-1),
      };
      this.ports.set(port, c);
    }
    return c;
  }

  private tick(c: Counts): void {
    const sec = Math.floor(this.now() / 1000);
    const i = sec % RATE_WINDOW_S;
    if (c.ringSec[i] !== sec) {
      c.ringSec[i] = sec;
      c.ring[i] = 0;
    }
    c.ring[i]!++;
    c.heard++;
  }

  /** A packet a port heard: it counts as parsed when its APRS payload decodes to a known type. */
  packet(p: Packet): void {
    const c = this.of(p.port);
    if (!c) return;
    this.tick(c);
    if (
      p.kind !== "other" ||
      decodeAprs({ src: p.src, dst: p.dst ?? "", path: p.path, payload: p.payload, raw: "" }).kind !== "other"
    )
      c.parsed++;
  }

  /** A frame a port heard that is not a packet: a broken AX.25 frame, a line that is no TNC2 packet. */
  invalid(port: string): void {
    const c = this.of(port);
    if (!c) return;
    this.tick(c);
    c.invalid++;
  }

  /** Packets per second of a port over the last {@link RATE_WINDOW_S} seconds. */
  private pps(c: Counts): number {
    const sec = Math.floor(this.now() / 1000);
    let n = 0;
    for (let i = 0; i < RATE_WINDOW_S; i++) if (c.ringSec[i]! > sec - RATE_WINDOW_S) n += c.ring[i]!;
    return Math.round((n / RATE_WINDOW_S) * 100) / 100;
  }

  /** The ports heard from since the start: each is reported on, a quiet one with a rate of zero. */
  get size(): number {
    return this.ports.size;
  }

  /**
   * Each port's counts since the last committed report, and its current rate. `commit` marks them taken: call it
   * once the gateway accepted the batch that carried them.
   */
  report(): { ports: PortHealth[]; commit: () => void } {
    const snap = [...this.ports].map(([port, c]) => ({
      port,
      c,
      heard: c.heard,
      parsed: c.parsed,
      invalid: c.invalid,
    }));
    return {
      ports: snap.map((s) => ({
        port: s.port,
        heard: s.heard - s.c.sent.heard,
        parsed: s.parsed - s.c.sent.parsed,
        invalid: s.invalid - s.c.sent.invalid,
        pps: this.pps(s.c),
      })),
      commit: () => {
        for (const s of snap) s.c.sent = { heard: s.heard, parsed: s.parsed, invalid: s.invalid };
      },
    };
  }
}
