// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * txlimit.ts — the token buckets that pace unattended transmits.
 *
 * Every path that keys a transmitter without an operator at the radio (remote-box answers and beacons,
 * MeshCom sends, the TX-IGate, FBB forwarding sessions) draws from its own bucket: `burst` transmits at
 * once, then one more every `refillSec`. Each path has its own bucket so a busy one (IGate traffic) can
 * never starve another (an answer to a radio command), and so each unit is natural to the path — a frame
 * for the IGate, a connected session for FBB forwarding.
 *
 * The operator tunes each bucket from env, within a hard ceiling: a value past it is clamped with a
 * startup warning, so a typo can never turn an unattended station into a channel hog. Tightening is
 * always allowed.
 */
import { numEnv } from "./config.js";

export interface TokenBucketOpts {
  /** Transmits allowed at once from a full bucket. */
  burst: number;
  /** Seconds to refill one transmit. */
  refillSec: number;
  now?: () => number;
}

/** A continuously refilling token bucket. A full bucket banks no extra time. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(private o: TokenBucketOpts) {
    this.tokens = o.burst;
    this.at = this.now();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.o.burst, this.tokens + (t - this.at) / (this.o.refillSec * 1000));
    this.at = t;
  }

  /** Spend one transmit; false when the bucket is empty. */
  take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Whole seconds until the next transmit is allowed (0 when one is available now). */
  waitSec(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * this.o.refillSec);
  }
}

export type TxPath = "box" | "meshcom" | "igate" | "bbs";

interface TxLimitSpec {
  burstEnv: string;
  refillEnv: string;
  burst: number;
  refillSec: number;
  /** The ceiling: at most `maxBurst` at once, and never faster than one per `minRefillSec`. */
  maxBurst: number;
  minRefillSec: number;
}

/** Defaults and ceilings per path. Frames are capped at ten per minute; FBB sessions at one a minute. */
export const TX_LIMITS: Record<TxPath, TxLimitSpec> = {
  box: {
    burstEnv: "BOX_TX_BURST",
    refillEnv: "BOX_TX_REFILL_SEC",
    burst: 3,
    refillSec: 60,
    maxBurst: 10,
    minRefillSec: 6,
  },
  meshcom: {
    burstEnv: "MESHCOM_TX_BURST",
    refillEnv: "MESHCOM_TX_REFILL_SEC",
    burst: 3,
    refillSec: 60,
    maxBurst: 10,
    minRefillSec: 6,
  },
  igate: {
    burstEnv: "IGATE_TX_BURST",
    refillEnv: "IGATE_TX_REFILL_SEC",
    burst: 6,
    refillSec: 10,
    maxBurst: 10,
    minRefillSec: 6,
  },
  bbs: {
    burstEnv: "BBS_FORWARD_BURST",
    refillEnv: "BBS_FORWARD_REFILL_SEC",
    burst: 4,
    refillSec: 300,
    maxBurst: 10,
    minRefillSec: 60,
  },
};

/** One path's bucket settings from env, clamped to its ceiling. */
export function txLimitFromEnv(path: TxPath): { burst: number; refillSec: number } {
  const s = TX_LIMITS[path];
  return {
    burst: Math.floor(numEnv(s.burstEnv, s.burst, { min: 1, max: s.maxBurst })),
    refillSec: numEnv(s.refillEnv, s.refillSec, { min: s.minRefillSec, max: 86_400 }),
  };
}
