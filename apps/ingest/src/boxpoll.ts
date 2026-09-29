// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * boxpoll.ts — the box side of remote control. The web app enqueues commands at the gateway
 * (`POST /api/box/:id/command`); this poller leases them over the box's existing outbound connection
 * (`GET /api/box/:id/commands`), executes each one, and reports the outcome
 * (`POST /api/box/:id/commands/ack`). No inbound port is ever opened on the box.
 *
 * Pairing: at start the box asks the gateway for a one-time pairing code (`POST /api/box/:id/pair`, with
 * its secret) and prints it. The operator enters that code in the web app to link the box to their
 * account — only someone who can see this box's output can claim it. Restart the box for a fresh code.
 *
 * The gateway already requires a control-verified callsign for every transmit kind. The box enforces
 * its own, independent gates, because the shared ingest secret also lets a trusted backend enqueue:
 *  - remote transmit is off unless the operator opts in on the box (`BOX_TX=1`);
 *  - a transmit command must name a callsign whose base call is the box's own station call;
 *  - a transmit command older than `maxAgeSec` is refused, so a box that was offline never beacons a
 *    stale position or delivers a stale message when it reconnects;
 *  - remote transmits share a token bucket, so a flood of queued commands cannot key the radio in a burst.
 * Switching a function OFF is always honoured: a remote "TX off" must work even when remote transmit is
 * disabled, since it is the safety stop.
 *
 * The gateway also queues answers to radio commands (acks and replies to FOUND / DNF / NOTE / HELP
 * messages) for the box that heard them, so they go back the way the message came — on this box's RF as
 * third-party traffic from the service call under the box's licensed call, or through the MeshCom node
 * that heard it. They pass the same opt-in, transmit switch and age gates. The poll reports what the box
 * can send, so the gateway only routes answers here while it can deliver them.
 */
import { encodeAprsMessage, encodeAprsPosition } from "@aprscaching/aprs";

/** What the box can transmit through — the KISS TNC's UI-frame send. */
export interface BoxRadio {
  send(f: { src: string; dst: string; path?: string[]; payload: string }): boolean;
}

/** The runtime switches remote commands flip. `digi`/`igate` are null when that function isn't configured. */
export interface BoxState {
  /** Master RF transmit switch: off silences the digipeater, IGate RF transmit and remote transmits. */
  tx: boolean;
  digi: boolean | null;
  igate: boolean | null;
}

export interface BoxCommand {
  id: number;
  callsign?: string | null;
  kind: string;
  payload?: unknown;
  createdAt?: number;
}

export interface BoxResult {
  status: "done" | "failed";
  result: string;
}

/** A MeshCom sender the box can hand answers to (the opt-in `MeshcomSender`). */
export interface BoxMeshcom {
  /** Nodes the sender may use; `call` is what each node transmits under. */
  nodes: { ip: string; call?: string }[];
  send(req: {
    dst: string;
    text: string;
    feature: string;
    node?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface BoxPollerOpts {
  /** Gateway base URL (the ingest URL without `/ingest`). */
  base: string;
  secret: string;
  boxId: string;
  /** The station call this box transmits as; remote transmit needs a command callsign with the same base call. */
  boxCall?: string;
  /** Operator opt-in for remote transmit (`BOX_TX=1`). */
  remoteTx: boolean;
  /** RF transmitter, or null when the box has no TNC. */
  radio: BoxRadio | null;
  /** MeshCom sender, or null when MeshCom transmit is not enabled on this box. */
  meshcom?: BoxMeshcom | null;
  /** The gateway's service call answers are sent from (`BOX_SERVICE_CALL`, default `APRSCG`). */
  serviceCall?: string;
  state: BoxState;
  /** Digipeater path for remote beacons and messages. */
  path?: string[];
  tocall?: string;
  maxAgeSec?: number;
  pollMs?: number;
  /** Token bucket for remote transmits: `burst` tokens, one refilled every `refillSec`. */
  burst?: number;
  refillSec?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

const baseCall = (c: string) => (c.toUpperCase().split("-")[0] ?? "").trim();
const CALL_RE = /^[A-Z0-9]{1,6}(?:-[A-Z0-9]{1,2})?$/;
const MAX_PENDING_ACKS = 200;

/** Parse `BOX_TX_PATH` ("WIDE1-1,WIDE2-1"); an empty value means no digipeater path. */
export function parseBoxPath(raw: string | undefined): string[] {
  if (raw == null) return ["WIDE1-1", "WIDE2-1"];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function onFlag(payload: unknown): boolean | null {
  const on = (payload as { on?: unknown } | null)?.on;
  return typeof on === "boolean" ? on : null;
}

const fmtState = (v: boolean | null) => (v == null ? "n/a" : v ? "on" : "off");

export class BoxPoller {
  private tokens: number;
  private refilledAt: number;
  private pendingAcks: { id: number; status: string; result: string }[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private failing = false;
  private loggedAt = 0;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly log: (msg: string) => void;

  constructor(private o: BoxPollerOpts) {
    this.now = o.now ?? (() => Date.now());
    this.fetch = o.fetch ?? fetch;
    this.log = o.log ?? ((m) => console.log(m));
    this.tokens = o.burst ?? 3;
    this.refilledAt = this.now();
    this.startedAt = this.now();
  }

  get state(): BoxState {
    return this.o.state;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? 5000);
    this.timer.unref?.();
    void this.requestPairingCode();
    void this.tick();
  }

  /** Obtain a one-time pairing code from the gateway and print it for the operator. Never throws. */
  async requestPairingCode(): Promise<string | null> {
    try {
      const r = await this.fetch(this.url("/pair"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": this.o.secret },
        body: "{}",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { code, expiresAt } = (await r.json()) as { code?: string; expiresAt?: number };
      if (!code) throw new Error("no code in the answer");
      const mins = expiresAt ? Math.max(1, Math.round((expiresAt * 1000 - this.now()) / 60_000)) : 15;
      this.log(
        `[box] pairing code for ${this.o.boxId}: ${code} (valid ${mins} min) — enter it under Shack → Remote box to link this box to your account`,
      );
      return code;
    } catch (e) {
      this.log(`[box] pairing code unavailable (${(e as Error).message}); restart the box to try again`);
      return null;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private url(p: string): string {
    return `${this.o.base}/api/box/${encodeURIComponent(this.o.boxId)}${p}`;
  }

  /** One poll: flush acks still owed from an earlier tick, lease queued commands, execute, ack. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.flushAcks();
      const r = await this.fetch(this.url(`/commands?${this.capsQuery()}`), {
        headers: { "x-ingest-secret": this.o.secret },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { commands } = (await r.json()) as { commands?: BoxCommand[] };
      for (const cmd of commands ?? []) {
        const res = await this.execute(cmd);
        this.log(`[box] ${cmd.kind} #${cmd.id} ${res.status}: ${res.result}`);
        this.pendingAcks.push({ id: cmd.id, ...res });
      }
      await this.flushAcks();
      if (this.failing) {
        this.log("[box] command poll recovered");
        this.failing = false;
      }
    } catch (e) {
      this.failing = true;
      const t = this.now();
      if (t - this.loggedAt > 30_000) {
        this.log(`[box] command poll failed (${(e as Error).message}); retrying`);
        this.loggedAt = t;
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** Ack in order; stop at the first failure and keep the rest for the next tick (bounded, drop-oldest). */
  private async flushAcks(): Promise<void> {
    while (this.pendingAcks.length) {
      const a = this.pendingAcks[0]!;
      const r = await this.fetch(this.url("/commands/ack"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": this.o.secret },
        body: JSON.stringify(a),
      });
      if (!r.ok) {
        if (this.pendingAcks.length > MAX_PENDING_ACKS)
          this.pendingAcks.splice(0, this.pendingAcks.length - MAX_PENDING_ACKS);
        throw new Error(`ack HTTP ${r.status}`);
      }
      this.pendingAcks.shift();
    }
  }

  private takeToken(): boolean {
    const refill = (this.o.refillSec ?? 60) * 1000;
    const burst = this.o.burst ?? 3;
    const t = this.now();
    const gained = Math.floor((t - this.refilledAt) / refill);
    if (gained > 0) {
      this.tokens = Math.min(burst, this.tokens + gained);
      this.refilledAt += gained * refill;
    }
    if (this.tokens >= burst) this.refilledAt = t; // a full bucket banks no extra time
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** What this box can transmit, reported with every poll so the gateway routes answers only here when deliverable. */
  capsQuery(): string {
    const tx = this.o.remoteTx && this.o.state.tx;
    const meshcom = (this.o.meshcom?.nodes ?? []).map((n) => n.call?.toUpperCase()).filter((c): c is string => !!c);
    return `tx=${tx ? 1 : 0}&rf=${this.o.radio ? 1 : 0}&meshcom=${encodeURIComponent(meshcom.join(","))}`;
  }

  /** Gates shared by every answer to a radio command: operator opt-in, the transmit switch, command age. */
  private answerGate(cmd: BoxCommand): BoxResult | null {
    const fail = (result: string): BoxResult => ({ status: "failed", result });
    if (!this.o.remoteTx) return fail("remote transmit is disabled on this box (set BOX_TX=1)");
    if (!this.o.state.tx) return fail("transmit is switched off on this box");
    const maxAge = this.o.maxAgeSec ?? 900;
    if (cmd.createdAt != null && this.now() / 1000 - cmd.createdAt > maxAge)
      return fail(`expired — queued more than ${Math.round(maxAge / 60)} min ago`);
    return null;
  }

  /**
   * An APRS answer on RF: third-party traffic whose inner source is the gateway's service call, sent
   * under this box's licensed call — the form an IGate uses to gate APRS-IS messages to RF, so the
   * sender's radio sees the answer come from the address it messaged.
   */
  private aprsAnswer(cmd: BoxCommand, p: Record<string, unknown>): BoxResult {
    const fail = (result: string): BoxResult => ({ status: "failed", result });
    const service = (this.o.serviceCall ?? "APRSCG").toUpperCase();
    const from = String(p.from ?? "").toUpperCase();
    const to = String(p.to ?? "")
      .trim()
      .toUpperCase();
    const text = String(p.text ?? "").trim();
    if (from !== service) return fail(`only answers from ${service} are sent`);
    if (!CALL_RE.test(to)) return fail("answer needs a valid addressee");
    if (!text) return fail("answer text is empty");
    const gate = this.answerGate(cmd);
    if (gate) return gate;
    if (!this.o.boxCall) return fail("no station call configured on this box (set BOX_CALL)");
    if (!this.o.radio) return fail("no RF transmitter on this box (configure a KISS TNC)");
    if (!this.takeToken()) return fail("rate limited — too many remote transmits, try again in a minute");
    const tocall = this.o.tocall ?? "APZACG";
    const call = this.o.boxCall.toUpperCase();
    const ok = this.o.radio.send({
      src: call,
      dst: tocall,
      path: this.o.path ?? ["WIDE1-1", "WIDE2-1"],
      payload: `}${from}>${tocall},TCPIP,${call}*:${encodeAprsMessage(to, text)}`,
    });
    return ok ? { status: "done", result: `answer to ${to} sent as ${call}` } : fail("the TNC link is down");
  }

  /** A MeshCom answer, handed to the node that heard the message. The sender applies its own checks. */
  private async meshcomAnswer(cmd: BoxCommand, p: Record<string, unknown>): Promise<BoxResult> {
    const fail = (result: string): BoxResult => ({ status: "failed", result });
    const node = String(p.node ?? "").toUpperCase();
    const dst = String(p.dst ?? "")
      .trim()
      .toUpperCase();
    const text = String(p.text ?? "").trim();
    if (!CALL_RE.test(dst)) return fail("answer needs a valid addressee");
    if (!text) return fail("answer text is empty");
    const gate = this.answerGate(cmd);
    if (gate) return gate;
    const mc = this.o.meshcom;
    if (!mc) return fail("MeshCom transmit is not enabled on this box (set MESHCOM_TX=1)");
    const target = mc.nodes.find((n) => n.call?.toUpperCase() === node);
    if (!target) return fail(`no MeshCom node ${node || "?"} on this box`);
    const r = await mc.send({ dst, text, feature: "radio-answer", node: target.ip });
    return r.ok
      ? { status: "done", result: `answer to ${dst} handed to node ${node}` }
      : fail(`MeshCom node refused: ${r.reason}`);
  }

  /**
   * The box-side transmit gate. Returns the source callsign to transmit as, or a failure. Consumes a
   * rate-limit token only once every other check has passed.
   */
  private txGate(cmd: BoxCommand): { src: string } | BoxResult {
    const fail = (result: string): BoxResult => ({ status: "failed", result });
    if (!this.o.remoteTx) return fail("remote transmit is disabled on this box (set BOX_TX=1)");
    if (!this.o.state.tx) return fail("transmit is switched off on this box");
    const src = String(cmd.callsign ?? "").toUpperCase();
    if (!this.o.boxCall) return fail("no station call configured on this box (set BOX_CALL)");
    if (!src || !CALL_RE.test(src) || baseCall(src) !== baseCall(this.o.boxCall))
      return fail(`${src || "no callsign"} is not this box's station call`);
    const maxAge = this.o.maxAgeSec ?? 900;
    if (cmd.createdAt != null && this.now() / 1000 - cmd.createdAt > maxAge)
      return fail(`expired — queued more than ${Math.round(maxAge / 60)} min ago`);
    if (!this.o.radio) return fail("no RF transmitter on this box (configure a KISS TNC)");
    if (!this.takeToken()) return fail("rate limited — too many remote transmits, try again in a minute");
    return { src };
  }

  private transmit(cmd: BoxCommand, payload: string, what: string): BoxResult {
    const g = this.txGate(cmd);
    if ("status" in g) return g;
    const ok = this.o.radio!.send({
      src: g.src,
      dst: this.o.tocall ?? "APZACG",
      path: this.o.path ?? ["WIDE1-1", "WIDE2-1"],
      payload,
    });
    return ok
      ? { status: "done", result: `${what} sent as ${g.src}` }
      : { status: "failed", result: "the TNC link is down" };
  }

  /** Switch a function. OFF is always honoured; ON is a transmit decision and passes the full gate. */
  private toggle(cmd: BoxCommand, key: "tx" | "digi" | "igate", label: string): BoxResult {
    const on = onFlag(cmd.payload);
    if (on == null) return { status: "failed", result: "payload must be { on: true | false }" };
    if (key !== "tx" && this.o.state[key] == null)
      return { status: "failed", result: `no ${label} is configured on this box` };
    if (on) {
      if (!this.o.remoteTx)
        return { status: "failed", result: "remote transmit is disabled on this box (set BOX_TX=1)" };
      const src = String(cmd.callsign ?? "").toUpperCase();
      if (!this.o.boxCall || !src || baseCall(src) !== baseCall(this.o.boxCall))
        return { status: "failed", result: `${src || "no callsign"} is not this box's station call` };
    }
    this.o.state[key] = on;
    return { status: "done", result: `${label} ${on ? "on" : "off"}` };
  }

  private status(): BoxResult {
    const up = Math.floor((this.now() - this.startedAt) / 1000);
    const h = Math.floor(up / 3600),
      m = Math.floor((up % 3600) / 60);
    const s = this.o.state;
    const parts = [
      `up ${h}h${String(m).padStart(2, "0")}m`,
      `rf ${this.o.radio ? "kiss" : "none"}`,
      `tx ${fmtState(s.tx)}`,
      `digi ${fmtState(s.digi)}`,
      `igate ${fmtState(s.igate)}`,
      `remote tx ${this.o.remoteTx ? "allowed" : "disabled"}`,
    ];
    return { status: "done", result: parts.join(" · ") };
  }

  async execute(cmd: BoxCommand): Promise<BoxResult> {
    const p = (cmd.payload ?? {}) as Record<string, unknown>;
    switch (cmd.kind) {
      case "aprs_msg":
        return this.aprsAnswer(cmd, p);
      case "meshcom_msg":
        return this.meshcomAnswer(cmd, p);
      case "status":
        return this.status();
      case "beacon": {
        const lat = Number(p.lat),
          lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
          return { status: "failed", result: "beacon needs a valid lat/lon" };
        const symbol = typeof p.symbol === "string" && p.symbol.length === 2 ? p.symbol : "/-";
        const comment = typeof p.comment === "string" ? p.comment : "";
        return this.transmit(cmd, encodeAprsPosition(lat, lon, symbol, comment), "beacon");
      }
      case "message": {
        const to = String(p.to ?? "")
          .trim()
          .toUpperCase();
        const text = String(p.text ?? "").trim();
        if (!/^[A-Z0-9-]{1,9}$/.test(to)) return { status: "failed", result: "message needs a valid addressee" };
        if (!text) return { status: "failed", result: "message text is empty" };
        return this.transmit(cmd, encodeAprsMessage(to, text), `message to ${to}`);
      }
      case "tx":
        return this.toggle(cmd, "tx", "transmit");
      case "digi":
        return this.toggle(cmd, "digi", "digipeater");
      case "igate":
        return this.toggle(cmd, "igate", "IGate");
      default:
        return { status: "failed", result: `${cmd.kind} is not supported by this box` };
    }
  }
}
