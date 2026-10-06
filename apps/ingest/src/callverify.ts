// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The transmit gate every transmit port of the box shares (the KISS TNC, the soundcard ports and the MeshCom
 * node): the box transmits only under station calls the gateway confirms for this box — control-verified, not
 * suspended, and held by the box's own operator (`GET /ingest/txgate`, workers/gateway/src/txgate.ts).
 * Receiving never needs it.
 *
 * The gate judges each frame by the box's calls it goes out under: its source and its via hops that are station
 * calls of the box ({@link frameCalls}). Every one of them must be confirmed, so a frame never goes out under a
 * call the gateway refused, while a refused call (an IGATE_CALL kept receive-only) holds back only its own
 * frames, not the digipeater's.
 *
 * With the shared INGEST_SECRET the gateway MACs the box's nonce and the body. That stops an attacker who can
 * change responses but cannot read requests; over plain http the request carries the secret, so a reader on
 * the path could compute the MAC too. Use https for a gateway that is not on loopback or the box's LAN (the
 * doctor warns otherwise). An enrolled box (its own key, no shared secret) accepts the answer only over https
 * or loopback.
 *
 * The box asks every three minutes. An answer that a call is not verified, or not this box's operator's,
 * closes the gate for that call at once. While the gateway cannot be reached (a network error, a timeout, a
 * 5xx, a 404 from a gateway without the endpoint, an answer without a valid MAC), the last confirmed answer
 * keeps counting for the grace the sysop sets (`TX_GATE_GRACE`, 6 minutes to 24 hours, default 6 minutes);
 * past it the gate closes until the gateway answers again. Meanwhile the box asks again after 30 s, backing
 * off to the interval, and logs each distinct failure once. A gateway that refuses the box's credential
 * (401, 403) closes the gate at once.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gatewayFetch } from "./gatewayauth.js";

export interface GateAnswer {
  ok: boolean;
  reason?: string;
}
export type TxGateLookup = (calls: string[]) => Promise<Map<string, GateAnswer>>;

/** `TX_GATE_GRACE`: the default, and the bounds it is clamped to. */
const GRACE_MIN = 6;
const GRACE_MAX = 24 * 60;

/**
 * `TX_GATE_GRACE` in ms: minutes as a plain number (`30`), or with a unit (`30m`, `2h`). Blank is the default,
 * six minutes; a value outside 6 minutes to 24 hours is clamped with a warning. Throws on anything else.
 */
export function txGateGraceMs(raw: string | undefined, warn: (m: string) => void = console.warn): number {
  const v = (raw ?? "").trim();
  if (!v) return GRACE_MIN * 60_000;
  const m = /^(\d+)\s*(m|min|h)?$/i.exec(v);
  if (!m) throw new Error(`TX_GATE_GRACE: expected minutes, such as 30, 30m or 2h`);
  const minutes = Number(m[1]) * (m[2]?.toLowerCase() === "h" ? 60 : 1);
  const clamped = Math.min(GRACE_MAX, Math.max(GRACE_MIN, minutes));
  if (clamped !== minutes)
    warn(`[config] TX_GATE_GRACE=${v} is outside 6 minutes to 24 hours; using ${clamped} minutes`);
  return clamped * 60_000;
}

export interface CallVerifierOpts {
  /** Between refreshes while the gateway answers (default 3 min). */
  intervalMs?: number;
  /** How long the last confirmed answer counts while the gateway cannot be reached (default 6 min). */
  graceMs?: number;
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
  /** The gateway has no /ingest/txgate: said once, in its own words. */
  private unsupported = false;
  private interval: number;
  private grace: number;
  private retry: number;

  constructor(
    private lookup: TxGateLookup,
    private o: CallVerifierOpts = {},
  ) {
    this.interval = o.intervalMs ?? 180_000;
    this.grace = o.graceMs ?? GRACE_MIN * 60_000;
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
      // a refused credential is an answer, not an outage: it closes the gate at once
      if (e instanceof TxGateRefused) {
        const at = this.now();
        for (const c of list) this.answers.set(c, { answer: { ok: false, reason: this.lastError }, at });
      }
      return false;
    }
  }

  /**
   * Refresh now and keep refreshing: every interval while the gateway answers, sooner while it does not. `calls`
   * may be a function, read at every refresh, for a set that grows (the service call, once the gateway names it).
   */
  start(calls: readonly string[] | (() => readonly string[]), after?: () => void): void {
    const tick = async () => {
      const ok = await this.refresh(typeof calls === "function" ? calls() : calls);
      after?.();
      const wait = ok ? this.interval : Math.min(this.interval, this.retry * 2 ** (this.failures - 1));
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
      // a positive answer lasts the grace; a negative one stands until the gateway says otherwise
      if (!a || (a.answer.ok && now - a.at > this.grace))
        return `the gateway has not confirmed ${c} recently${this.lastError ? ` (${this.lastError})` : ""}`;
      if (a.answer.ok) continue;
      return a.answer.reason === "not control-verified"
        ? `verify ${c} to transmit — control-verification required`
        : `${c} cannot transmit from this box: ${a.answer.reason ?? "refused"}`;
    }
    return null;
  }
}

/** A call as the gate keys it: upper-case, without the has-been-repeated mark and without a zero SSID. */
const gateKey = (c: string) => c.trim().toUpperCase().replace(/\*$/, "").replace(/-0$/, "");

/**
 * The station calls of the box (`own`) a frame goes out under: those among its addresses (`addrs`: the source,
 * then the via hops, as `CALL-SSID` with an optional `*`). A frame that names none of them, such as a repeat
 * through an alias the connected digipeater serves, goes out under `fallback` (the digipeater's call); with no
 * fallback it goes out under no call of the box, and the gate refuses it.
 */
export function frameCalls(own: readonly string[], addrs: readonly string[], fallback?: string): string[] {
  const mine = new Set(own.map(gateKey));
  const hit = [...new Set(addrs.map(gateKey).filter((a) => mine.has(a)))];
  return hit.length ? hit : fallback ? [gateKey(fallback)] : [];
}

/** Why a frame with these addresses may not go out now, or null: {@link frameCalls}, then the verifier. */
export function frameRefusal(
  verifier: Pick<CallVerifier, "refusal">,
  own: readonly string[],
  addrs: readonly string[],
  fallback?: string,
): string | null {
  const calls = frameCalls(own, addrs, fallback);
  return calls.length ? verifier.refusal(calls) : "the frame names none of this box's station calls";
}

/**
 * A transmit check for a port that holds no gate of its own (the KISS TNC): called with a frame's addresses,
 * true when the box's switch is on and the gateway confirms the calls the frame goes out under
 * ({@link frameCalls}); a refusal is logged once per change of reason.
 */
export function gateCheck(
  verifier: Pick<CallVerifier, "refusal">,
  own: () => readonly string[],
  fallback: string | undefined,
  master: () => boolean,
  log: (msg: string) => void,
): (addrs: readonly string[]) => boolean {
  let logged: string | null = null;
  return (addrs) => {
    const why = master() ? frameRefusal(verifier, own(), addrs, fallback) : "transmit is switched off on this box";
    if (why && why !== logged) log(`transmit refused: ${why}`);
    logged = why;
    return !why;
  };
}

/** The gateway has no /ingest/txgate (an older version): counted as unreachable. */
export class TxGateUnsupported extends Error {}
/** The gateway refused the box's credential (401, 403): the gate closes at once. */
export class TxGateRefused extends Error {}

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
    if (r.status === 401 || r.status === 403)
      throw new TxGateRefused(`the gateway refused this box's credential (HTTP ${r.status})`);
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
 * Whether any function of the box would transmit: a soundcard port with transmit on, MeshCom transmit
 * (`MESHCOM_TX`), or a KISS TNC with a transmitting function set. A receive-only box never asks the gateway
 * about its calls.
 */
export function boxTransmits(env: Record<string, string | undefined>, soundcardTx: boolean): boolean {
  if (soundcardTx) return true;
  if (env.MESHCOM_NODE && env.MESHCOM_TX === "1") return true;
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
 * source or as the digipeater's own hop, and MeshCom transmit goes out under MESHCOM_TX_CALL. The gateway's
 * service call joins them once the gateway names it.
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
    "MESHCOM_TX_CALL",
  ] as const;
  const calls = [portCall, ...keys.map((k) => env[k])]
    .map((c) => c?.trim().toUpperCase())
    .filter((c): c is string => !!c);
  return [...new Set(calls)];
}
