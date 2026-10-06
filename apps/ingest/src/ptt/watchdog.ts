// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The transmit watchdog. Every key request arms a timer, and the timer is disarmed only once an unkey is
 * confirmed. Each driver call is bounded by `opTimeoutMs`. The watchdog trips, at once, when:
 *  - the key time runs out (a playback that never ends);
 *  - an unkey fails or does not answer in time (a driver that hangs);
 *  - a key fails and the unkey after it fails too.
 * Tripping releases the PTT by every means the driver has (its synchronous path first, then unkey, retried)
 * and latches a fault that refuses every further key until the ingest restarts. A stuck transmitter therefore
 * holds the channel for at most `maxKeyMs` plus a few driver timeouts, and the operator learns of it from the
 * log and the box's status.
 */
import type { Ptt } from "./types.js";

export interface WatchdogOpts {
  /** The longest the PTT may stay keyed. */
  maxKeyMs: number;
  /** The longest one driver call (key, unkey) may take (default 2000 ms). */
  opTimeoutMs?: number;
  /** Called once when the watchdog trips, with the reason. */
  onFault: (reason: string) => void;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** `p`, or a rejection once `ms` pass. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export class PttWatchdog implements Ptt {
  private timer: unknown = null;
  private keyed = false;
  private faultReason: string | null = null;
  private tripping: Promise<void> | null = null;

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

  /** Whether the PTT may be keyed: from a key request until a confirmed unkey. */
  get isKeyed(): boolean {
    return this.keyed;
  }

  private get opMs(): number {
    return this.o.opTimeoutMs ?? 2000;
  }

  async key(): Promise<void> {
    if (this.faultReason) throw new Error(`PTT is locked out: ${this.faultReason}`);
    // the timer runs from the key request: a driver that hangs while keying is bounded too
    this.arm();
    this.keyed = true;
    try {
      await withTimeout(this.ptt.key(), this.opMs, `${this.ptt.label} key`);
    } catch (e) {
      try {
        await this.confirmUnkey();
      } catch (u) {
        await this.trip(
          `keying failed (${(e as Error).message}) and the unkey after it failed: ${(u as Error).message}`,
        );
      }
      throw e;
    }
  }

  async unkey(): Promise<void> {
    if (this.tripping) return this.tripping;
    try {
      await this.confirmUnkey();
    } catch (e) {
      await this.trip(`the unkey failed: ${(e as Error).message}`);
      throw e;
    }
  }

  async close(): Promise<void> {
    try {
      await this.unkey();
    } finally {
      await withTimeout(this.ptt.close(), this.opMs, `${this.ptt.label} close`).catch((e: Error) => {
        console.error("[ptt] %s", e.message);
        this.ptt.releaseSync?.();
      });
    }
  }

  releaseSync(): void {
    this.ptt.releaseSync?.();
  }

  /** Unkey and wait for the driver to confirm it; only then is the timer disarmed. */
  private async confirmUnkey(): Promise<void> {
    await withTimeout(this.ptt.unkey(), this.opMs, `${this.ptt.label} unkey`);
    this.disarm();
    this.keyed = false;
  }

  private arm(): void {
    this.disarm();
    const set = this.o.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.timer = set(() => void this.trip(`transmitter keyed longer than ${this.o.maxKeyMs} ms`), this.o.maxKeyMs);
  }

  private disarm(): void {
    if (this.timer === null) return;
    (this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  /** Latch the fault and release the PTT by every means; resolves once released, or once every attempt failed. */
  private trip(why: string): Promise<void> {
    if (this.tripping) return this.tripping;
    this.timer = null;
    this.faultReason ??= `${why}; PTT released by the watchdog`;
    this.o.onFault(this.faultReason);
    this.tripping = (async () => {
      try {
        this.ptt.releaseSync?.();
      } catch (e) {
        console.error("[ptt] watchdog: the synchronous release of %s failed: %s", this.ptt.label, (e as Error).message);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.confirmUnkey();
          return;
        } catch (e) {
          console.error("[ptt] watchdog could not unkey %s: %s", this.ptt.label, (e as Error).message);
        }
      }
      console.error("[ptt] watchdog: %s may still be keyed; the radio's own time-out must end it", this.ptt.label);
    })().finally(() => {
      this.tripping = null;
    });
    return this.tripping;
  }
}
