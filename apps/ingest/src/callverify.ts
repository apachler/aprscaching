// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The transmit gate every RF transmit port of the box shares (the KISS TNC and the soundcard ports): the box
 * transmits only under station calls the gateway confirms for this box — control-verified, and held by the
 * box's own operator (`GET /ingest/txgate`, workers/gateway/src/txgate.ts). Receiving never needs it.
 *
 * With the shared INGEST_SECRET the gateway MACs the box's nonce and the body. That stops an attacker who can
 * change responses but cannot read requests; over plain http the request carries the secret, so a reader on
 * the path could compute the MAC too. Use https for a gateway that is not on loopback or the box's LAN (the
 * doctor warns otherwise). An enrolled box (its own key, no shared secret) accepts the answer only over https
 * or loopback.
 *
 * A gateway without the endpoint (HTTP 404, an older version) is logged once and asked again only at the
 * normal interval; the gate stays closed meanwhile.
 *
 * Every answer is fresh for two refresh intervals (three minutes each), so a revoked verification closes the
 * gate within minutes. Without a fresh answer a call counts as unconfirmed, and the box asks again after 30 s,
 * backing off to the interval while the gateway stays unreachable.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gatewayFetch } from "./gatewayauth.js";

export interface GateAnswer {
  ok: boolean;
  reason?: string;
}
export type TxGateLookup = (calls: string[]) => Promise<Map<string, GateAnswer>>;

export interface CallVerifierOpts {
  /** Between refreshes while the gateway answers (default 3 min); an answer is fresh for two of them. */
  intervalMs?: number;
  /** The first retry after a failed refresh (default 30 s), doubling up to the interval. */
  retryMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export class CallVerifier {
  private answers = new Map<string, { answer: GateAnswer; at: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lastError: string | null = null;
  private loggedError: string | null = null;
  /** The gateway has no /ingest/txgate: no fast retries, one log line. */
  private unsupported = false;
  private interval: number;
  private retry: number;

  constructor(
    private lookup: TxGateLookup,
    private o: CallVerifierOpts = {},
  ) {
    this.interval = o.intervalMs ?? 180_000;
    this.retry = o.retryMs ?? 30_000;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Ask the gateway about `calls`; false when it could not be asked (the old answers age out). */
  async refresh(calls: readonly string[]): Promise<boolean> {
    const list = [...new Set(calls.map((c) => c.trim().toUpperCase()).filter(Boolean))];
    if (!list.length) return true;
    try {
      const got = await this.lookup(list);
      const at = this.now();
      for (const c of list) this.answers.set(c, { answer: got.get(c) ?? { ok: false, reason: "no answer" }, at });
      this.failures = 0;
      this.lastError = null;
      this.loggedError = null;
      this.unsupported = false;
      return true;
    } catch (e) {
      this.failures++;
      this.lastError = (e as Error).message;
      this.unsupported = e instanceof TxGateUnsupported;
      return false;
    }
  }

  /** Refresh now and keep refreshing: every interval while the gateway answers, sooner while it does not. */
  start(calls: readonly string[], after?: () => void): void {
    const tick = async () => {
      const ok = await this.refresh(calls);
      after?.();
      const wait =
        ok || this.unsupported ? this.interval : Math.min(this.interval, this.retry * 2 ** (this.failures - 1));
      // each distinct failure is logged once, not at every retry
      if (!ok && this.lastError !== this.loggedError) {
        this.loggedError = this.lastError;
        this.o.log?.(
          this.unsupported
            ? `[txgate] ${this.lastError}; transmit stays off until the gateway is updated`
            : `[txgate] the gateway did not answer (${this.lastError}); asking again in ${Math.round(wait / 1000)} s`,
        );
      }
      this.timer = setTimeout(() => void tick(), wait);
      this.timer.unref?.();
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Why the box may not transmit under `calls` now, or null when every one is confirmed and fresh. */
  refusal(calls: readonly string[]): string | null {
    if (!calls.length) return "no station call is set (BOX_CALL, DIGI_CALL, IGATE_CALL or SOUNDCARD_CALL)";
    const now = this.now();
    for (const raw of calls) {
      const c = raw.toUpperCase();
      const a = this.answers.get(c);
      if (!a || now - a.at > 2 * this.interval)
        return `the gateway has not confirmed ${c} recently${this.lastError ? ` (${this.lastError})` : ""}`;
      if (a.answer.ok) continue;
      return a.answer.reason === "not control-verified"
        ? `verify ${c} to transmit — control-verification required`
        : `${c} cannot transmit from this box: ${a.answer.reason ?? "refused"}`;
    }
    return null;
  }
}

/**
 * A transmit check for a port that holds no gate of its own (the KISS TNC): true when the box's switch is on
 * and the gateway confirms `calls`; a refusal is logged once per change of reason.
 */
export function gateCheck(
  verifier: Pick<CallVerifier, "refusal">,
  calls: readonly string[],
  master: () => boolean,
  log: (msg: string) => void,
): () => boolean {
  let logged: string | null = null;
  return () => {
    const why = master() ? verifier.refusal(calls) : "transmit is switched off on this box";
    if (why && why !== logged) log(`transmit refused: ${why}`);
    logged = why;
    return !why;
  };
}

/** The gateway has no /ingest/txgate (an older version). */
export class TxGateUnsupported extends Error {}

const isLoopback = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i.test(host);

/**
 * The lookup against the gateway (`ingestUrl` is INGEST_URL, `…/ingest`). `boxKey` says the box signs with its
 * own key (gatewayFetch does it), else it sends the shared secret and checks the answer's MAC.
 */
export function gatewayTxGateLookup(o: {
  ingestUrl: string;
  secret: string;
  boxKey: boolean;
  boxId?: string;
  fetch?: typeof fetch;
}): TxGateLookup {
  const f = o.fetch ?? gatewayFetch;
  return async (calls) => {
    const url = new URL(`${o.ingestUrl.replace(/\/+$/, "")}/txgate`);
    if (o.boxKey && url.protocol !== "https:" && !isLoopback(url.hostname))
      throw new Error("an enrolled box takes the gateway's transmit answer only over https: set an https INGEST_URL");
    const nonce = randomBytes(18).toString("base64url");
    url.searchParams.set("calls", calls.join(","));
    url.searchParams.set("nonce", nonce);
    if (o.boxId) url.searchParams.set("box", o.boxId);
    const r = await f(url.toString(), { headers: { "x-ingest-secret": o.secret } });
    if (r.status === 404) throw new TxGateUnsupported("the gateway has no /ingest/txgate (HTTP 404)");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.text();
    if (!o.boxKey) {
      const mac = Buffer.from(r.headers.get("x-txgate-mac") ?? "", "hex");
      const want = createHmac("sha256", o.secret).update(`${nonce}\n${body}`).digest();
      if (mac.length !== want.length || !timingSafeEqual(mac, want))
        throw new Error("the gateway's answer does not carry a valid MAC");
    }
    const parsed = JSON.parse(body) as { calls?: Record<string, GateAnswer> };
    return new Map(
      Object.entries(parsed.calls ?? {}).map(([k, v]) => [k.toUpperCase(), { ok: v.ok === true, reason: v.reason }]),
    );
  };
}

/**
 * Whether any function of the box would transmit over RF: a soundcard port with transmit on, or a KISS TNC with
 * a transmitting function set. A receive-only box never asks the gateway about its calls.
 */
export function boxTransmits(env: Record<string, string | undefined>, soundcardTx: boolean): boolean {
  if (soundcardTx) return true;
  if (!env.KISS_TNC_HOST) return false;
  const on = (k: string) => env[k] === "1";
  return !!(
    env.DIGI_CALL ||
    on("IGATE_TX") ||
    on("BOX_TX") ||
    env.NETROM_CALL ||
    env.BBS_NODE_CALL ||
    on("BBS_FORWARD") ||
    on("FED_LINK_SERVE") ||
    on("FED_LINK_PULL")
  );
}

/**
 * The station calls a box transmits under, from its settings: every frame it sends carries one of them as its
 * source or as the digipeater's own hop.
 */
export function stationCalls(env: Record<string, string | undefined>, portCall?: string): string[] {
  const keys = [
    "DIGI_CALL",
    "IGATE_CALL",
    "BOX_CALL",
    "NETROM_CALL",
    "BBS_NODE_CALL",
    "BBS_FORWARD_CALL",
    "FED_LINK_CALL",
  ] as const;
  const calls = [portCall, ...keys.map((k) => env[k])]
    .map((c) => c?.trim().toUpperCase())
    .filter((c): c is string => !!c);
  return [...new Set(calls)];
}
