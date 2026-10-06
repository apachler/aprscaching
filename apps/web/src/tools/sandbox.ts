// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * sandbox.ts — the sandbox every tool runs in. The app has no tools of its own: each one, the project's first-party
 * tools included, is a signed script from a registry or an address, and runs in a Worker that lives inside an
 * `<iframe sandbox="allow-scripts" srcdoc>`. The frame has an opaque origin, so the tool shares no storage, cookies,
 * IndexedDB keys or service worker with the app, and the frame's CSP limits its connections to the origins its
 * manifest lists in `connect` when it holds the 'network' grant (none otherwise). Without that grant the worker's
 * network globals are shadowed as well.
 *
 * The script runs as the body of a function of `register`, `ipc` and `tool` (the tool reference documents the API).
 * Every message from the frame is shape-checked here, and every request a tool makes reaches the shared ToolHost
 * through the tool's own capability-checked context (`bind`): the host enforces the grants, the transmit gate and
 * its rate limit exactly as it does for any tool. Commands and decoders answer asynchronously from the worker.
 */
import {
  isToolEvent,
  sanitizeMapLayer,
  sanitizePanel,
  validateManifest,
  type Capability,
  type Colouriser,
  type Tool,
  type ToolContext,
  type ToolEvent,
  type ToolEventPayload,
  type ToolManifest,
} from "@aprscaching/tools";
import { DIRECT, type Carrier } from "./registries.js";

/**
 * Fetch and validate a tool's manifest. `url` is its upstream address, which `base` keeps for resolving the
 * script and for the registry match; `carrier` decides where the bytes come from (this instance or the publisher).
 */
export async function fetchToolManifest(
  url: string,
  carrier: Carrier = DIRECT,
): Promise<
  { ok: true; manifest: ToolManifest; raw: Record<string, unknown>; base: string } | { ok: false; error: string }
> {
  try {
    const res = await fetch(carrier.fetchUrl(new URL(url, location.href).href), carrier.init);
    if (!res.ok) return { ok: false, error: `manifest ${res.status}` };
    const raw = (await res.json()) as Record<string, unknown>;
    const v = validateManifest(raw);
    if (!v.ok) return v;
    // the signature covers the file as written, so the caller checks it over `raw`, not the normalised manifest
    return { ok: true, manifest: v.manifest, raw, base: new URL(url, location.href).href };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * A declarative monitor colour rule, evaluated host-side (sync), so no per-line Worker round-trip. `src` matches a
 * callsign exactly; the prefixes and `textIncludes` match the start of a field or a substring.
 */
export interface ColourRule {
  src?: string;
  srcPrefix?: string;
  dstPrefix?: string;
  textIncludes?: string;
  colorVar?: string;
  hidden?: boolean;
}
/** Decoder metadata a tool contributes; the decode itself runs in the worker (async). */
export interface DecoderMeta {
  id: string;
  label: string;
  kind: string;
  /** A line to try the decoder on, offered as "Use a sample". */
  sample?: string;
  /** What the input box shows while empty. */
  placeholder?: string;
}

/** Rules beyond these are dropped: exact-callsign rules are a map lookup, the others are scanned per line. */
export const MAX_EXACT_RULES = 2000;
export const MAX_SCAN_RULES = 40;

/** Compile colour rules into a sync colouriser (no per-line Worker call). */
export function compileRules(rules: readonly ColourRule[]): Colouriser {
  const safeVar = (v?: string) => (v && /^--[a-z0-9-]+$/i.test(v) ? v : undefined);
  const exact = new Map<string, ColourRule>();
  const scan: ColourRule[] = [];
  for (const r of rules) {
    if (r.src) {
      const k = r.src.toUpperCase();
      if (!exact.has(k) && exact.size < MAX_EXACT_RULES) exact.set(k, r);
    } else if ((r.srcPrefix || r.dstPrefix || r.textIncludes) && scan.length < MAX_SCAN_RULES) scan.push(r); // a rule must match on something
  }
  const out = (r: ColourRule) => ({ colorVar: safeVar(r.colorVar), hidden: !!r.hidden });
  return (line) => {
    const hit = exact.get(line.src.toUpperCase());
    if (hit) return out(hit);
    for (const r of scan) {
      if (r.srcPrefix && !line.src.toUpperCase().startsWith(r.srcPrefix.toUpperCase())) continue;
      if (r.dstPrefix && !line.dst.toUpperCase().startsWith(r.dstPrefix.toUpperCase())) continue;
      if (r.textIncludes && !line.text.includes(r.textIncludes)) continue;
      return out(r);
    }
    return null;
  };
}

/** The worker bootstrap (stringified): locks down globals, runs the tool, and bridges its API over postMessage. */
function workerSource(): string {
  return `
    let commands = {}, colourRules = [], panel = null, decoderFns = {}, decoderMeta = [], granted = [];
    const subs = {}, handlers = {}, services = {}, pending = {};
    let seq = 0;
    const msg = (e) => String((e && e.message) || e);
    const post = (m) => self.postMessage(m);
    // A result that cannot cross postMessage (a function, a DOM-like object) is answered with an error instead.
    const answer = (m, fail) => { try { post(m); } catch (e) { post(fail(msg(e))); } };
    const need = (c) => { if (granted.indexOf(c) < 0) throw new Error("permission '" + c + "' not granted"); };
    const ask = (m) => new Promise((res, rej) => { const id = ++seq; pending[id] = { res, rej }; post(Object.assign({ id }, m)); });
    const run = (fn, arg) => { try { return Promise.resolve(fn(arg)); } catch (e) { return Promise.reject(e); } };
    const lines = (out) => [].concat(out == null ? [] : out).map(String);
    const setPanel = (spec) => { panel = spec; post({ type: "panel", spec }); };
    const subscribe = (topic, cb) => {
      need("ipc"); topic = String(topic); if (typeof cb !== "function") return;
      if (!subs[topic]) { subs[topic] = []; post({ type: "subscribe", topic }); }
      subs[topic].push(cb);
    };
    const provide = (name, fn) => {
      need("ipc"); name = String(name); if (typeof fn !== "function") return;
      const first = !services[name]; services[name] = fn; if (first) post({ type: "provide", name });
    };
    const ipc = {
      emit: (topic, data) => post({ type: "emit", topic: String(topic), data }),
      subscribe, provide,
      call: (name, args) => ask({ type: "call", name: String(name), args }),
      setPanel,
    };
    const tool = {
      permissions: [],
      log: (m) => post({ type: "log", msg: String(m) }),
      setPanel: (spec) => { need("panel"); setPanel(spec); },
      setMapLayer: (spec) => { need("map"); post({ type: "map", spec }); },
      setColourRules: (rules) => { need("monitor"); post({ type: "colours", rules: Array.isArray(rules) ? rules : [] }); },
      on: (event, fn) => {
        event = String(event); need(event === "on_frame" ? "monitor" : "event"); if (typeof fn !== "function") return;
        if (!handlers[event]) { handlers[event] = []; post({ type: "on", event }); }
        handlers[event].push(fn);
      },
      requestTx: (info) => { need("tx"); return ask({ type: "tx", info: String(info) }); },
      scheduleBeacon: (spec) => {
        need("beacon");
        return ask({ type: "beacon", spec: spec == null ? null : { comment: String(spec.comment), intervalSec: Number(spec.intervalSec) } });
      },
      emit: (topic, data) => { need("ipc"); ipc.emit(topic, data); },
      subscribe, provide,
      call: (name, args) => { need("ipc"); return ipc.call(name, args); },
    };
    const register = (t) => {
      commands = {};
      const c = (t && t.commands) || {};
      for (const w of Object.keys(c)) {
        const v = c[w];
        if (typeof v === "function") commands[w] = { run: v, remote: false };
        else if (v && typeof v.run === "function") commands[w] = { run: v.run, remote: v.remote === true };
      }
      colourRules = Array.isArray(t && t.colourRules) ? t.colourRules.slice(0, 40) : [];
      if (t && t.panel !== undefined) panel = t.panel;
      decoderFns = {}; decoderMeta = [];
      for (const d of (t && t.decoders) || []) if (d && d.id && typeof d.decode === "function") {
        decoderFns[d.id] = d.decode;
        decoderMeta.push({ id: String(d.id), label: String(d.label || d.id), kind: String(d.kind || d.id),
          sample: typeof d.sample === "string" ? d.sample : undefined, placeholder: typeof d.placeholder === "string" ? d.placeholder : undefined });
      }
    };
    self.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "load") {
        granted = Array.isArray(m.permissions) ? m.permissions.map(String) : [];
        tool.permissions = granted.slice();
        if (!m.network) { for (const g of ["fetch","XMLHttpRequest","WebSocket","WebTransport","EventSource","importScripts","Worker","SharedWorker"]) { try { self[g] = undefined; } catch (e) {} } }
        try {
          new Function("register", "ipc", "tool", m.script)(register, m.ipc ? ipc : undefined, tool);
          const words = Object.keys(commands);
          post({ type: "loaded", commands: words, remoteOff: words.filter((w) => !commands[w].remote), colourRules, panel, decoders: decoderMeta });
        } catch (e) { post({ type: "error", error: msg(e) }); }
      } else if (m.type === "cmd") {
        const c = commands[m.word];
        const fail = (e) => ({ type: "cmdResult", id: m.id, lines: ["error: " + e] });
        if (!c) post({ type: "cmdResult", id: m.id, lines: ["no such command"] });
        else run(c.run, m.args).then((out) => answer({ type: "cmdResult", id: m.id, lines: lines(out) }, fail), (e) => post(fail(msg(e))));
      } else if (m.type === "decode") {
        const fn = decoderFns[m.decId];
        const fail = (e) => ({ type: "decodeResult", id: m.id, out: "error: " + e });
        if (!fn) post({ type: "decodeResult", id: m.id, out: "no such decoder" });
        else run(fn, String(m.input)).then((out) => answer({ type: "decodeResult", id: m.id, out: String(out) }, fail), (e) => post(fail(msg(e))));
      } else if (m.type === "ipcEvent") {
        for (const cb of subs[m.topic] || []) { try { cb(m.data, m.from); } catch (e) {} }
      } else if (m.type === "event") {
        const p = Object.assign({}, m.payload);
        if (m.replyId) p.reply = (text) => post({ type: "reply", replyId: m.replyId, text: String(text) });
        for (const fn of handlers[m.event] || []) run(fn, p).catch((e) => tool.log(m.event + ": " + msg(e)));
      } else if (m.type === "svcCall") {
        const fn = services[m.name];
        const fail = (e) => ({ type: "svcResult", id: m.id, error: e });
        if (!fn) post(fail("no such service"));
        else run(fn, m.args).then((r) => answer({ type: "svcResult", id: m.id, result: r }, fail), (e) => post(fail(msg(e))));
      } else if (m.type === "callResult") {
        const p = pending[m.id]; if (p) { delete pending[m.id]; if (typeof m.error === "string") p.rej(new Error(m.error)); else p.res(m.result); }
      }
    };`;
}

/** How long the frame may take to start the worker and load the tool before the import fails. */
const LOAD_TIMEOUT_MS = 15_000;
/** How long a command, a decode or a service call may take before it answers with an error. */
export const ANSWER_TIMEOUT_MS = 10_000;
/** How long a tool may answer a connected session after the event that offered the reply, and how often. */
export const REPLY_TTL_MS = 120_000;
export const REPLY_MAX = 4;
export const REPLY_TEXT_MAX = 256;
/** A tool's bridge budget: messages per second, the size of one message, and the services and topics it holds. */
export const MSG_PER_SEC = 200;
export const MSG_MAX_BYTES = 64 * 1024;
export const MAX_SERVICES = 16;
export const MAX_TOPICS = 32;
const LINES_MAX = 200;
const LINE_MAX = 1000;
const DECODE_OUT_MAX = 20_000;
const MAX_LIST = 200;
const LOG_MAX = 300;

/**
 * The frame's Content-Security-Policy. Scripts run inline and from blob: (the worker), and the worker
 * evaluates the tool's source. Connections go to `connect` only; an empty list blocks every request.
 */
export function frameCsp(connect: string[]): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob:",
    "worker-src blob:",
    `connect-src ${connect.length ? connect.join(" ") : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * The origins a tool's frame may connect to: its manifest's `connect` list when it holds the 'network'
 * grant, minus the app's own origins (the page and the API, in http and ws form), so a tool never
 * addresses the app's API from inside the sandbox.
 */
export function connectSources(granted: Capability[], connect: string[] | undefined, appOrigins: string[]): string[] {
  if (!granted.includes("network") || !connect?.length) return [];
  const own = new Set<string>();
  for (const o of appOrigins) {
    try {
      const u = new URL(o);
      own.add(`${u.protocol}//${u.host}`);
      own.add(`${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`);
    } catch {
      /* not a URL */
    }
  }
  return connect.filter((o) => !own.has(o));
}

/** The frame document: its CSP, then a relay between the parent window and the tool's worker. */
export function frameSource(csp: string): string {
  // `<` is escaped so the worker source can never close the inline script element.
  const src = JSON.stringify(workerSource()).replace(/</g, "\\u003c");
  const attr = csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attr}"><script>
const w = new Worker(URL.createObjectURL(new Blob([${src}], { type: "text/javascript" })));
w.onmessage = (e) => parent.postMessage(e.data, "*");
w.onerror = (e) => { e.preventDefault(); parent.postMessage({ type: "error", error: String(e.message || "tool worker failed") }, "*"); };
addEventListener("message", (e) => { if (e.source === parent) w.postMessage(e.data); });
parent.postMessage({ type: "ready" }, "*");
</script>`;
}

/** One message from the frame, after its shape is checked. Anything else is dropped. */
export type FrameMessage =
  | { type: "ready" }
  | { type: "error"; error: string }
  | {
      type: "loaded";
      commands: string[];
      remoteOff: string[];
      colourRules: ColourRule[];
      panel: unknown | null;
      decoders: DecoderMeta[];
    }
  | { type: "cmdResult"; id: number; lines: string[] }
  | { type: "decodeResult"; id: number; out: string }
  | { type: "panel"; spec: unknown }
  | { type: "map"; spec: unknown }
  | { type: "colours"; rules: ColourRule[] }
  | { type: "log"; msg: string }
  | { type: "on"; event: ToolEvent }
  | { type: "tx"; id: number; info: string }
  | { type: "beacon"; id: number; spec: unknown }
  | { type: "reply"; replyId: number; text: string }
  | { type: "emit"; topic: string; data: unknown }
  | { type: "subscribe"; topic: string }
  | { type: "provide"; name: string }
  | { type: "call"; id: number; name: string; args: unknown }
  | { type: "svcResult"; id: number; result?: unknown; error?: string };

const isStr = (x: unknown): x is string => typeof x === "string";
const isId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
const optStr = (x: unknown, cap = 200): string | undefined => (isStr(x) ? x.slice(0, cap) : undefined);

function colourRule(x: unknown): ColourRule | null {
  if (typeof x !== "object" || x === null) return null;
  const r = x as Record<string, unknown>;
  return {
    src: optStr(r.src, 12),
    srcPrefix: optStr(r.srcPrefix, 12),
    dstPrefix: optStr(r.dstPrefix, 12),
    textIncludes: optStr(r.textIncludes, 64),
    colorVar: optStr(r.colorVar, 40),
    hidden: r.hidden === true,
  };
}

function decoderMeta(x: unknown): DecoderMeta | null {
  if (typeof x !== "object" || x === null) return null;
  const d = x as Record<string, unknown>;
  if (!isStr(d.id) || !isStr(d.label) || !isStr(d.kind)) return null;
  const meta: DecoderMeta = { id: d.id, label: d.label, kind: d.kind };
  if (isStr(d.sample)) meta.sample = d.sample.slice(0, 2000);
  if (isStr(d.placeholder)) meta.placeholder = d.placeholder.slice(0, 120);
  return meta;
}

function listOf<T>(x: unknown, f: (v: unknown) => T | null, max = MAX_LIST): T[] {
  if (!Array.isArray(x)) return [];
  const out: T[] = [];
  for (const v of x.slice(0, max)) {
    const r = f(v);
    if (r !== null) out.push(r);
  }
  return out;
}

/** Check the shape of a message from the frame; `null` for anything that is not one of the known kinds. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "error":
      return { type: "error", error: isStr(m.error) ? m.error.slice(0, 500) : "tool failed" };
    case "loaded":
      return {
        type: "loaded",
        commands: listOf(m.commands, (v) => (isStr(v) ? v : null)),
        remoteOff: listOf(m.remoteOff, (v) => (isStr(v) ? v : null)),
        colourRules: listOf(m.colourRules, colourRule).slice(0, MAX_SCAN_RULES),
        panel: m.panel ?? null,
        decoders: listOf(m.decoders, decoderMeta),
      };
    case "cmdResult":
      return isId(m.id) && Array.isArray(m.lines)
        ? { type: "cmdResult", id: m.id, lines: m.lines.slice(0, LINES_MAX).map((l) => String(l).slice(0, LINE_MAX)) }
        : null;
    case "decodeResult":
      return isId(m.id) && isStr(m.out)
        ? { type: "decodeResult", id: m.id, out: m.out.slice(0, DECODE_OUT_MAX) }
        : null;
    case "panel":
      return { type: "panel", spec: m.spec };
    case "map":
      return { type: "map", spec: m.spec };
    case "colours":
      return { type: "colours", rules: listOf(m.rules, colourRule, MAX_EXACT_RULES + MAX_SCAN_RULES) };
    case "log":
      return isStr(m.msg) ? { type: "log", msg: m.msg.slice(0, LOG_MAX) } : null;
    case "on":
      return isToolEvent(m.event) ? { type: "on", event: m.event } : null;
    case "tx":
      return isId(m.id) && isStr(m.info) ? { type: "tx", id: m.id, info: m.info } : null;
    case "beacon":
      return isId(m.id) ? { type: "beacon", id: m.id, spec: m.spec ?? null } : null;
    case "reply":
      return isId(m.replyId) && isStr(m.text) ? { type: "reply", replyId: m.replyId, text: m.text } : null;
    case "emit":
      return isStr(m.topic) ? { type: "emit", topic: m.topic, data: m.data } : null;
    case "subscribe":
      return isStr(m.topic) ? { type: "subscribe", topic: m.topic } : null;
    case "provide":
      return isStr(m.name) ? { type: "provide", name: m.name } : null;
    case "call":
      return isId(m.id) && isStr(m.name) ? { type: "call", id: m.id, name: m.name, args: m.args } : null;
    case "svcResult":
      return isId(m.id)
        ? { type: "svcResult", id: m.id, result: m.result, ...(isStr(m.error) ? { error: m.error.slice(0, 500) } : {}) }
        : null;
    default:
      return null;
  }
}

/**
 * The part of an event a tool's worker receives: the strings and the channel number the surface supplied, and the
 * station record when it is plain data. The `reply` callback never crosses; the worker gets a reply id instead.
 */
export function workerPayload(p: ToolEventPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["surface", "source", "peerCall", "myCall", "dst", "text"]) {
    const v = p[k];
    if (typeof v === "string") out[k] = v.slice(0, 512);
  }
  if (typeof p.channel === "number" && Number.isFinite(p.channel)) out.channel = p.channel;
  if (p.station && typeof p.station === "object") {
    try {
      const s = JSON.stringify(p.station);
      if (s.length <= 2048) out.station = JSON.parse(s);
    } catch {
      /* not plain data */
    }
  }
  return out;
}

/** A reply text as one line within REPLY_TEXT_MAX characters. */
const replyText = (t: string) => t.replace(/[\r\n\0]+/g, " ").slice(0, REPLY_TEXT_MAX);

/** Settle like `p`, or with `fallback` (which may throw) after `ms`, so an unanswered request never hangs its caller. */
function within<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        resolve(fallback());
      } catch (e) {
        reject(e as Error);
      }
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

/**
 * The host side of one tool's sandbox: it keeps what the tool contributed (its panel, map layer, colour rules,
 * event hooks, services and bus topics) and applies it to the tool's ToolContext while the tool is switched on.
 * Every request goes through that context, so the ToolHost checks the grant, the transmit gate and the rate limit;
 * a switched-off tool reaches nothing. Free of the DOM: `post` delivers a message to the worker.
 */
export class SandboxBridge {
  commands: string[] = [];
  remoteOff: string[] = [];
  decoders: DecoderMeta[] = [];
  colourRules: ColourRule[] = [];
  panel: unknown | null = null;
  private map: unknown | null = null;
  private colouriser: Colouriser = () => null;
  private events = new Set<ToolEvent>();
  private services = new Set<string>();
  private topics = new Set<string>();
  private ctx: ToolContext | null = null;
  private seq = 0;
  private replySeq = 0;
  private replies = new Map<number, { fn: (t: string) => void; left: number; until: number }>();
  private waiting = new Map<number, (m: FrameMessage) => void>();
  private svcSeq = 0;
  private svcWaiting = new Map<number, (r: { result?: unknown; error?: string }) => void>();

  constructor(
    private post: (msg: unknown) => void,
    private granted: readonly Capability[],
    private opts: { now?: () => number; onChange?: () => void } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private windowStart = 0;
  private windowCount = 0;
  private overReported = false;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Admit one raw message from the worker against the tool's budget: at most MSG_PER_SEC a second and
   * MSG_MAX_BYTES each (as JSON). A message over budget is dropped, and the tool log says so once a second.
   */
  admit(raw: unknown): boolean {
    const now = this.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
      this.overReported = false;
    }
    let size = Infinity;
    try {
      size = JSON.stringify(raw)?.length ?? 0;
    } catch {
      /* not plain data: over budget */
    }
    const why =
      ++this.windowCount > MSG_PER_SEC
        ? `more than ${MSG_PER_SEC} messages a second`
        : size > MSG_MAX_BYTES
          ? `a message over ${MSG_MAX_BYTES} bytes`
          : null;
    if (!why) return true;
    if (!this.overReported) {
      this.overReported = true;
      this.ctx?.log(`dropped: ${why}`);
    }
    return false;
  }

  /** Tell the host's surfaces to re-read, at most once per 100 ms. */
  private changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.opts.onChange?.();
    }, 100);
  }

  /** Take what the tool registered while it loaded. */
  loaded(m: Extract<FrameMessage, { type: "loaded" }>): void {
    this.commands = m.commands;
    this.remoteOff = m.remoteOff.filter((w) => m.commands.includes(w));
    this.decoders = m.decoders;
    if (m.colourRules.length) this.setRules(m.colourRules);
    if (m.panel != null) this.panel = m.panel;
  }

  /** Apply the tool's contributions to its context (switched on), or forget the context (switched off). */
  bind(ctx: ToolContext | null): void {
    this.ctx = ctx;
    this.replies.clear();
    if (!ctx) return;
    const tryDo = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        ctx.log(`${what}: ${(e as Error).message}`);
      }
    };
    if (this.granted.includes("monitor")) tryDo("colours", () => ctx.addColouriser((l) => this.colouriser(l)));
    if (this.panel != null) tryDo("panel", () => ctx.setPanel(sanitizePanel(this.panel)));
    if (this.map != null) tryDo("map", () => ctx.setMapLayer(sanitizeMapLayer(this.map)));
    for (const e of this.events) tryDo(e, () => this.hook(ctx, e));
    for (const s of this.services) tryDo(`service ${s}`, () => this.provide(ctx, s));
    for (const t of this.topics) tryDo(`topic ${t}`, () => this.subscribe(ctx, t));
  }

  /** Handle one checked message from the worker (everything except the load handshake). */
  receive(m: FrameMessage): void {
    const ctx = this.ctx;
    const guard = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        ctx?.log(`${what}: ${(e as Error).message}`);
      }
    };
    switch (m.type) {
      case "cmdResult":
      case "decodeResult":
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
        return;
      case "svcResult":
        this.svcWaiting.get(m.id)?.(m);
        this.svcWaiting.delete(m.id);
        return;
      case "panel":
        this.panel = m.spec;
        if (ctx) guard("panel", () => ctx.setPanel(sanitizePanel(m.spec)));
        return;
      case "map":
        this.map = m.spec;
        if (ctx) guard("map", () => ctx.setMapLayer(sanitizeMapLayer(m.spec)));
        return;
      case "colours":
        if (!this.granted.includes("monitor")) return ctx?.log("colours: permission 'monitor' not granted");
        this.setRules(m.rules);
        if (ctx) this.changed(); // the monitor re-reads its colours
        return;
      case "log":
        ctx?.log(m.msg);
        return;
      case "on":
        if (this.events.has(m.event)) return;
        this.events.add(m.event);
        if (ctx) guard(m.event, () => this.hook(ctx, m.event));
        return;
      case "provide":
        if (this.services.has(m.name)) return;
        if (this.services.size >= MAX_SERVICES) return ctx?.log(`provide: at most ${MAX_SERVICES} services`);
        this.services.add(m.name);
        if (ctx) guard(`service ${m.name}`, () => this.provide(ctx, m.name));
        return;
      case "subscribe":
        if (this.topics.has(m.topic)) return;
        if (this.topics.size >= MAX_TOPICS) return ctx?.log(`subscribe: at most ${MAX_TOPICS} topics`);
        this.topics.add(m.topic);
        if (ctx) guard(`topic ${m.topic}`, () => this.subscribe(ctx, m.topic));
        return;
      case "emit":
        if (ctx) guard("emit", () => ctx.emit(m.topic, m.data));
        return;
      case "reply":
        this.reply(m.replyId, m.text);
        return;
      case "tx":
        this.answer(m.id, () => ctx!.requestTx(m.info));
        return;
      case "beacon":
        this.answer(m.id, () => {
          ctx!.scheduleBeacon(m.spec === null ? null : (m.spec as { comment: string; intervalSec: number }));
          return true;
        });
        return;
      case "call":
        this.answer(m.id, () => ctx!.callService(m.name, m.args));
        return;
    }
  }

  /** Answer a request the tool is awaiting: the value, or the error that rejects its promise. */
  private answer(id: number, fn: () => unknown): void {
    const send = (r: { result?: unknown; error?: string }) => {
      try {
        this.post({ type: "callResult", id, ...r });
      } catch {
        this.post({ type: "callResult", id, error: "the answer could not be sent to the tool" });
      }
    };
    if (!this.ctx) return send({ error: "the tool is switched off" });
    let value: unknown;
    try {
      value = fn();
    } catch (e) {
      return send({ error: (e as Error).message || "refused" });
    }
    void within<{ result?: unknown; error?: string }>(
      Promise.resolve(value).then((result) => ({ result })),
      ANSWER_TIMEOUT_MS,
      () => ({ error: "no answer in time" }),
    ).then(send, (e: unknown) => send({ error: (e as Error).message || "failed" }));
  }

  private setRules(rules: ColourRule[]): void {
    this.colourRules = rules;
    this.colouriser = compileRules(rules);
  }

  /** Forward one event to the worker; a payload's `reply` becomes a short-lived, capped reply id. */
  private hook(ctx: ToolContext, event: ToolEvent): void {
    ctx.on(event, (p) => {
      let replyId: number | undefined;
      if (typeof p.reply === "function") {
        replyId = ++this.replySeq;
        this.replies.set(replyId, { fn: p.reply, left: REPLY_MAX, until: this.now() + REPLY_TTL_MS });
        for (const [id, r] of this.replies) if (r.until < this.now()) this.replies.delete(id);
      }
      this.post({ type: "event", event, payload: workerPayload(p), ...(replyId ? { replyId } : {}) });
    });
  }

  private reply(id: number, text: string): void {
    const r = this.replies.get(id);
    if (!r || !this.ctx || !this.granted.includes("event")) return;
    if (r.until < this.now() || r.left <= 0) {
      this.replies.delete(id);
      this.ctx.log("reply refused: the session's reply window has closed");
      return;
    }
    r.left--;
    r.fn(replyText(text));
  }

  /** Offer a service the worker answers; callers get a promise, answered or failed within ANSWER_TIMEOUT_MS. */
  private provide(ctx: ToolContext, name: string): void {
    ctx.provideService(name, (args) => {
      const id = ++this.svcSeq;
      const answer = new Promise<unknown>((resolve, reject) => {
        this.svcWaiting.set(id, (r) => (typeof r.error === "string" ? reject(new Error(r.error)) : resolve(r.result)));
        this.post({ type: "svcCall", id, name, args });
      });
      return within(answer, ANSWER_TIMEOUT_MS, () => {
        this.svcWaiting.delete(id);
        throw new Error(`service "${name}" did not answer in time`);
      });
    });
  }

  private subscribe(ctx: ToolContext, topic: string): void {
    ctx.subscribe(topic, (data, from) => this.post({ type: "ipcEvent", topic, data, from }));
  }

  private request<T>(msg: Record<string, unknown>, pick: (m: FrameMessage) => T, fallback: T): Promise<T> {
    const id = ++this.seq;
    return within(
      new Promise<T>((resolve) => {
        this.waiting.set(id, (m) => resolve(pick(m)));
        this.post({ ...msg, id });
      }),
      ANSWER_TIMEOUT_MS,
      () => {
        this.waiting.delete(id);
        return fallback;
      },
    );
  }

  runCommand(word: string, args: string): Promise<string[]> {
    return this.request({ type: "cmd", word, args }, (m) => (m.type === "cmdResult" ? m.lines : []), [
      "error: the tool did not answer",
    ]);
  }

  decode(decId: string, input: string): Promise<string> {
    return this.request(
      { type: "decode", decId, input },
      (m) => (m.type === "decodeResult" ? m.out : ""),
      "error: the tool did not answer",
    );
  }
}

/** A loaded tool: its contributions, its commands and decoders, and the switch that ties it to the host. */
export interface Sandbox {
  commands: string[];
  /** The commands the tool keeps from remote peers (`{ remote: false }`). */
  remoteOff: string[];
  colourRules: ColourRule[];
  panel: unknown | null; // the latest declarative PanelSpec (sanitised when applied)
  decoders: DecoderMeta[];
  runCommand(word: string, args: string): Promise<string[]>;
  decode(id: string, input: string): Promise<string>;
  /** Apply the tool's contributions to its context while it is switched on; null while it is off. */
  bind(ctx: ToolContext | null): void;
  destroy(): void;
}

export interface SandboxOptions {
  /** The manifest's `connect` origins; reachable only with the 'network' grant. */
  connect?: string[];
  /** The app's own origins (page and API), which the frame never connects to. */
  appOrigins?: string[];
  /** The tool changed something the host's surfaces draw without a panel or map update (its colour rules). */
  onChange?: () => void;
}

/**
 * Load a tool script into a worker inside a sandboxed frame. `script` is the code, already checked against the
 * manifest's signed `entrySha256` (registries.ts fetchToolScript). `granted` are the user-approved capabilities; the
 * worker gets `ipc` only with the 'ipc' grant. `destroy()` removes the frame, which ends its worker.
 */
export async function loadSandbox(script: string, granted: Capability[], opts: SandboxOptions = {}): Promise<Sandbox> {
  const network = granted.includes("network");
  const csp = frameCsp(connectSources(granted, opts.connect, opts.appOrigins ?? [location.origin]));
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.hidden = true;
  frame.srcdoc = frameSource(csp);

  // The frame's origin is opaque, so "*" is the only target origin postMessage accepts for it.
  const post = (msg: unknown) => frame.contentWindow?.postMessage(msg, "*");
  const bridge = new SandboxBridge(post, granted, { onChange: opts.onChange });

  let onLoad: ((m: FrameMessage) => void) | null = null;
  const onMessage = (ev: MessageEvent) => {
    if (!frame.contentWindow || ev.source !== frame.contentWindow) return;
    const m = parseFrameMessage(ev.data);
    if (!m) return;
    if (m.type === "ready" || m.type === "loaded" || m.type === "error") {
      onLoad?.(m);
      return;
    }
    if (bridge.admit(ev.data)) bridge.receive(m);
  };

  const destroy = () => {
    bridge.bind(null);
    window.removeEventListener("message", onMessage);
    frame.remove();
  };

  window.addEventListener("message", onMessage);
  try {
    const loaded = await new Promise<Extract<FrameMessage, { type: "loaded" }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the tool did not start in time")), LOAD_TIMEOUT_MS);
      onLoad = (m) => {
        if (m.type === "ready") {
          post({ type: "load", script, network, ipc: granted.includes("ipc"), permissions: granted });
          return;
        }
        clearTimeout(timer);
        if (m.type === "loaded") resolve(m);
        else if (m.type === "error") reject(new Error(m.error));
      };
      document.body.appendChild(frame);
    });
    bridge.loaded(loaded);
  } catch (e) {
    destroy();
    throw e;
  } finally {
    onLoad = null;
  }

  return {
    get commands() {
      return bridge.commands;
    },
    get remoteOff() {
      return bridge.remoteOff;
    },
    get colourRules() {
      return bridge.colourRules;
    },
    get panel() {
      return bridge.panel;
    },
    get decoders() {
      return bridge.decoders;
    },
    runCommand: (word, args) => bridge.runCommand(word, args),
    decode: (id, input) => bridge.decode(id, input),
    bind: (ctx) => bridge.bind(ctx),
    destroy,
  };
}

/**
 * The host's view of a sandboxed tool: switching it on binds the sandbox to the tool's capability-checked context,
 * switching it off unbinds it. `entry` is always set, which is how the host's list marks a sandboxed tool.
 */
export function sandboxTool(manifest: ToolManifest, sandbox: Pick<Sandbox, "bind">): Tool {
  return {
    manifest: { ...manifest, entry: manifest.entry ?? "tool.js" },
    activate: (ctx) => sandbox.bind(ctx),
    deactivate: () => sandbox.bind(null),
  };
}
