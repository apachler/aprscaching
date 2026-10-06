// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The transmit watchdog. Every key starts a timer; a PTT still keyed when it runs out is released by force,
 * and the watchdog latches a fault that refuses every further key until the ingest restarts. A stuck
 * transmitter (a playback that never ends, a driver that never answers) therefore holds the channel for at
 * most `maxKeyMs`, and the operator learns of it from the log and the box's status.
 */
import type { Ptt } from "./types.js";

export interface WatchdogOpts {
  /** The longest the PTT may stay keyed. */
  maxKeyMs: number;
  /** Called once when the watchdog trips, with the reason. */
  onFault: (reason: string) => void;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class PttWatchdog implements Ptt {
  private timer: unknown = null;
  private keyed = false;
  private faultReason: string | null = null;

  constructor(
    private ptt: Ptt,
    private o: WatchdogOpts,
  ) {}

  get label(): string {
    return this.ptt.label;
  }

  /** Why the watchdog latched, or null while it has not tripped. */
  get fault(): string | null {
    return this.faultReason;
  }

  get isKeyed(): boolean {
    return this.keyed;
  }

  async key(): Promise<void> {
    if (this.faultReason) throw new Error(`PTT is locked out: ${this.faultReason}`);
    // the timer runs from the key request: a driver that hangs while keying is bounded too
    this.arm();
    this.keyed = true;
    try {
      await this.ptt.key();
    } catch (e) {
      this.disarm();
      this.keyed = false;
      await this.ptt.unkey().catch(() => {});
      throw e;
    }
  }

  async unkey(): Promise<void> {
    this.disarm();
    this.keyed = false;
    await this.ptt.unkey();
  }

  async close(): Promise<void> {
    this.disarm();
    this.keyed = false;
    await this.ptt.close();
  }

  releaseSync(): void {
    this.disarm();
    this.keyed = false;
    this.ptt.releaseSync?.();
  }

  private arm(): void {
    this.disarm();
    const set = this.o.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.timer = set(() => void this.trip(), this.o.maxKeyMs);
  }

  private disarm(): void {
    if (this.timer === null) return;
    (this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private async trip(): Promise<void> {
    this.timer = null;
    if (!this.keyed) return;
    this.keyed = false;
    this.faultReason = `transmitter keyed longer than ${this.o.maxKeyMs} ms; PTT released by the watchdog`;
    this.o.onFault(this.faultReason);
    // release by every means the driver has: the synchronous path first, then the normal unkey, retried once
    try {
      this.ptt.releaseSync?.();
    } catch {
      /* the asynchronous unkey below still runs */
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ptt.unkey();
        return;
      } catch (e) {
        console.error(`[ptt] watchdog could not unkey ${this.ptt.label}: ${(e as Error).message}`);
      }
    }
  }
}
