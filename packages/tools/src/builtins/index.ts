// SPDX-License-Identifier: MIT
/**
 * builtins/index.ts — the curated built-in Tools. Each is a plain module implementing the
 * Tool interface (no sandbox needed — they're first-party + trusted), demonstrating every extension
 * point: a monitor colouriser (off the NAMES.GP registry), a CTEXT macro pack (/commands), an
 * auto-responder (on_connect greeting), a beacon scheduler (TX-gated), and the PSK31 + CW decoders.
 * The event payloads may carry a `reply` callback so a tool can answer a connected session generically.
 */
import { StationRegistry } from "@aprscaching/packet";
import type { Tool } from "../host.js";
import { parseBlocks, sanitizePanel, type PanelSpec } from "../panel.js";
import { decodeMorse, encodeMorse } from "../decoders/morse.js";
import { decodeVaricode } from "../decoders/psk31.js";
import { decode7plus } from "../decoders/sevenplus.js";
import { parseScript, type ScriptState } from "../session-script.js";

/** Coerce an untrusted event-payload value to a string; an object becomes "" (never "[object Object]"). */
const asStr = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";

const AUTHOR = "OE8APR";
const v = "1.0.0";

/** Monitor colouriser — tags each heard frame with its NAMES.GP station-type colour token. */
export function colouriserTool(registry = new StationRegistry()): Tool {
  return {
    manifest: {
      name: "monitor-colouriser",
      title: "Monitor colouriser",
      author: AUTHOR,
      version: v,
      permissions: ["monitor"],
      surfaces: ["terminal"],
      description: "Colours heard traffic by NAMES.GP station type.",
    },
    activate(ctx) {
      ctx.addColouriser((line) => {
        const type = registry.classify(line.src, { dest: line.dst, payload: line.text });
        return { colorVar: `--st-${type}` };
      });
    },
  };
}

/** CTEXT macro pack — a few /commands that expand to canned text. */
export function macroPackTool(): Tool {
  const macros: Record<string, string> = {
    cq: "CQ CQ CQ de {call} k",
    "73": "73 es gud dx de {call}",
    qth: "QTH is {grid}",
  };
  return {
    manifest: {
      name: "ctext-macros",
      title: "CTEXT macro pack",
      author: AUTHOR,
      version: v,
      permissions: ["command"],
      surfaces: ["terminal", "bbs"],
      description: "Canned /cq /73 /qth text macros.",
    },
    activate(ctx) {
      for (const [word, text] of Object.entries(macros)) ctx.registerCommand(word, () => [text]);
    },
  };
}

/** Auto-responder — GP PMS-style: greet an incoming connect, personalised with the peer's callsign
 * . */
export function autoResponderTool(): Tool {
  return {
    manifest: {
      name: "auto-responder",
      title: "Auto-responder",
      author: AUTHOR,
      version: v,
      permissions: ["event"],
      surfaces: ["terminal", "bbs", "node"],
      description: "Greets an incoming connect (QTEXT/PMS style).",
    },
    activate(ctx) {
      ctx.on("on_connect", (p) => {
        const who = p.peerCall ? ` ${p.peerCall}` : "";
        p.reply?.(
          `Welcome${who} - this is${p.myCall ? ` ${p.myCall}` : " an APRScaching"} auto-responder. Type H for help.`,
        );
      });
    },
  };
}

// ---- small pure helpers for the tools below ----
// Maidenhead pair bases: field 18 · square 10 · subsquare 24 · ext-square 10 · ext-subsquare 24.
const MH_BASES = [18, 10, 24, 10, 24];
/** Maidenhead locator → lat/lon (centre of the smallest cell); accepts 4/6/8/10-char. Null if malformed. */
function gridToLatLon(loc: string): { lat: number; lon: number } | null {
  const g = loc.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2}([A-X]{2})?)?)?$/.test(g)) return null;
  const pairs = g.match(/../g)!;
  let lon = -180,
    lat = -90,
    lonCell = 360,
    latCell = 180;
  for (let p = 0; p < pairs.length; p++) {
    lonCell /= MH_BASES[p]!;
    latCell /= MH_BASES[p]!;
    const base = p === 0 || p % 2 === 0 ? 65 : 48;
    lon += (pairs[p]!.charCodeAt(0) - base) * lonCell;
    lat += (pairs[p]!.charCodeAt(1) - base) * latCell;
  }
  return { lat: lat + latCell / 2, lon: lon + lonCell / 2 };
}
/** Great-circle distance (km) + initial bearing (°) between two points. */
function distBearing(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): { km: number; bearing: number } {
  const R = 6371,
    rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad,
    dLon = (b.lon - a.lon) * rad;
  const la1 = a.lat * rad,
    la2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return { km, bearing: (Math.atan2(y, x) / rad + 360) % 360 };
}
/** Compact relative-time label from a unix-ms timestamp (for the heard/watch panels). */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

/** Watch/alert — highlight + log heard callsigns you `/watch` (GP/LinPac WATCH/CATCH). Records
 *  from the `on_frame` feed (every source — terminal RF, APRS, …), so alerts fire even off the Monitor
 *  tab; the colouriser only highlights the line when the monitor pane is visible. */
export function watchAlertTool(): Tool {
  return {
    manifest: {
      name: "watch-alert",
      title: "Watch & alert",
      author: AUTHOR,
      version: v,
      permissions: ["command", "monitor", "panel"],
      surfaces: ["terminal", "web"],
      description: "Highlight + log heard callsigns you /watch (any source); see hits in a panel.",
    },
    activate(ctx) {
      const watched = () =>
        ctx.store
          .keys()
          .filter((k) => k.startsWith("watch.") && ctx.store.get(k))
          .map((k) => k.slice(6));
      const isWatched = (call: string) =>
        !!(ctx.store.get("watch." + call) || ctx.store.get("watch." + call.split("-")[0]!));
      const rebuild = () => {
        const rows = watched().map((c) => [
          c,
          (() => {
            const h = ctx.store.get("watchhit." + c);
            return h ? `${ago(Number(h))} ago` : "—";
          })(),
        ]);
        ctx.setPanel({
          title: "Watch",
          nodes: rows.length
            ? [{ kind: "table", head: ["Call", "Last heard"], rows }]
            : [{ kind: "text", text: "No calls watched — /watch <CALL>", tone: "muted" }],
        });
      };
      ctx.registerCommand("watch", (args) => {
        const c = args.trim().toUpperCase();
        if (!c) {
          const l = watched();
          return [l.length ? `Watching: ${l.join(" ")}` : "Watching nothing. /watch <CALL>"];
        }
        ctx.store.set("watch." + c, "1");
        rebuild();
        return [`Watching ${c}.`];
      });
      ctx.registerCommand("unwatch", (args) => {
        const c = args.trim().toUpperCase();
        ctx.store.set("watch." + c, "");
        rebuild();
        return [`Unwatched ${c}.`];
      });
      // record a hit from any heard-frame source (works regardless of the active terminal view)
      ctx.on("on_frame", (p) => {
        const c = String(p.peerCall ?? "").toUpperCase();
        if (c && isWatched(c)) {
          ctx.store.set("watchhit." + c, String(Date.now()));
          rebuild();
        }
      });
      // colour the matched line while the monitor is on screen
      ctx.addColouriser((line) => (isWatched(line.src.toUpperCase()) ? { colorVar: "--warn" } : null));
      rebuild();
    },
  };
}

/** MHeard — a rolling recently-heard-stations panel (GP/LinPac MHEARD), aggregated across ALL
 *  sources that feed `on_frame`: the packet terminal (RF/TNC) and the live APRS layer today, plus any
 *  future source (a second TNC, DX cluster, …). Source-agnostic: a feeder just dispatches on_frame with
 *  a `source` label — see apps/web `feedHeard`. Works whatever terminal view is active. */
export function mheardTool(): Tool {
  return {
    manifest: {
      name: "mheard",
      title: "MHeard",
      author: AUTHOR,
      version: v,
      permissions: ["monitor", "event", "panel"],
      surfaces: ["terminal", "web"],
      description: "Rolling recently-heard stations, aggregated across sources (RF terminal, APRS, …).",
    },
    activate(ctx) {
      const rebuild = () => {
        const rows = ctx.store
          .keys()
          .filter((k) => k.startsWith("mh."))
          .map((k) => {
            const [ts, src = ""] = String(ctx.store.get(k)).split("\t");
            return { call: k.slice(3), ts: Number(ts), src };
          })
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 14)
          .map((x) => [x.call, x.src || "—", `${ago(x.ts)} ago`]);
        ctx.setPanel({
          title: "MHeard",
          nodes: rows.length
            ? [{ kind: "table", head: ["Station", "Src", "Heard"], rows }]
            : [{ kind: "text", text: "Nothing heard yet.", tone: "muted" }],
        });
      };
      ctx.on("on_frame", (p) => {
        const c = String(p.peerCall ?? "").toUpperCase();
        if (c) {
          ctx.store.set("mh." + c, `${Date.now()}\t${p.source ?? ""}`);
          rebuild();
        }
      });
      ctx.on("on_tick", rebuild);
      rebuild();
    },
  };
}

/** Auto-status — periodically transmit a status line via on_tick (GP timed macros); TX-gated. */
export function autoStatusTool(): Tool {
  return {
    manifest: {
      name: "auto-status",
      title: "Auto-status",
      author: AUTHOR,
      version: v,
      permissions: ["command", "event", "tx"],
      surfaces: ["terminal"],
      description: "/autostatus <min> <text> — periodically transmit a status (TX-gated).",
    },
    activate(ctx) {
      ctx.registerCommand("autostatus", (args) => {
        const parts = args.trim().split(/\s+/);
        if (parts[0] === "off" || !parts[0]) {
          ctx.store.set("as.min", "0");
          return ["Auto-status off."];
        }
        const min = Math.max(1, Number(parts[0]) || 10),
          text = parts.slice(1).join(" ") || "APRScaching";
        ctx.store.set("as.min", String(min));
        ctx.store.set("as.text", text);
        ctx.store.set("as.ticks", "0");
        return [`Auto-status every ${min} min: "${text}" (TX-gated).`];
      });
      ctx.on("on_tick", () => {
        const min = Number(ctx.store.get("as.min") || "0");
        if (min <= 0) return;
        const t = Number(ctx.store.get("as.ticks") || "0") + 1;
        if (t < min) {
          ctx.store.set("as.ticks", String(t));
          return;
        }
        ctx.store.set("as.ticks", "0");
        ctx.log(
          ctx.requestTx(ctx.store.get("as.text") || "APRScaching")
            ? "auto-status sent"
            : "auto-status held (TX gate closed)",
        );
      });
    },
  };
}

/** Grid & bearing — distance + bearing between Maidenhead locators; result shown in a panel. */
export function gridTool(): Tool {
  const panel = (
    a: string,
    pa: { lat: number; lon: number },
    b?: string,
    pb?: { lat: number; lon: number; km: number; bearing: number },
  ): PanelSpec => ({
    title: "Grid & bearing",
    nodes: [
      { kind: "kv", key: a.toUpperCase(), value: `${pa.lat.toFixed(4)}, ${pa.lon.toFixed(4)}` },
      ...(b && pb
        ? [
            { kind: "kv", key: b.toUpperCase(), value: `${pb.lat.toFixed(4)}, ${pb.lon.toFixed(4)}` } as const,
            { kind: "kv", key: "Distance", value: `${pb.km.toFixed(0)} km`, tone: "accent" } as const,
            { kind: "kv", key: "Bearing", value: `${pb.bearing.toFixed(0)}°`, tone: "accent" } as const,
          ]
        : []),
    ],
  });
  return {
    manifest: {
      name: "grid-bearing",
      title: "Grid & bearing",
      author: AUTHOR,
      version: v,
      permissions: ["command", "panel"],
      surfaces: ["web", "terminal", "bbs", "node"],
      remote: true,
      description:
        "/grid <locA> [locB] — distance + bearing between two Maidenhead locators (GP QTH; peers may query).",
    },
    activate(ctx) {
      ctx.registerCommand("grid", (args) => {
        const [a, b] = args.trim().split(/\s+/);
        const pa = gridToLatLon(a ?? "");
        if (!pa) return ["Usage: grid <locatorA> [locatorB]   e.g.  grid JN76jx JO30"];
        if (!b) {
          ctx.setPanel(panel(a!, pa));
          return [`${a!.toUpperCase()} = ${pa.lat.toFixed(4)}, ${pa.lon.toFixed(4)}`];
        }
        const pb = gridToLatLon(b);
        if (!pb) return [`Bad locator: ${b}`];
        const db = distBearing(pa, pb);
        ctx.setPanel(panel(a!, pa, b, { ...pb, ...db }));
        return [`${a!.toUpperCase()} → ${b.toUpperCase()}: ${db.km.toFixed(0)} km, bearing ${db.bearing.toFixed(0)}°`];
      });
    },
  };
}

/** 7PLUS reassembler — parse + stitch multi-part 7plus messages (decoder capability). */
export function sevenPlusTool(): Tool {
  return {
    manifest: {
      name: "sevenplus",
      title: "7PLUS reassembler",
      author: AUTHOR,
      version: v,
      permissions: ["decoder"],
      surfaces: ["web"],
      description: "Parse + reassemble multi-part 7plus messages (file / part / completeness).",
    },
    activate(ctx) {
      ctx.addDecoder({ id: "7plus", label: "7PLUS", kind: "7plus", decode: decode7plus });
    },
  };
}

/** (GP conv) Unit converter — `/conv <value> <from> <to>` for the common ham units. Pure + remote-safe. */
export function unitConverterTool(): Tool {
  // factor to multiply `from` → `to`; temperature handled specially below.
  const F: Record<string, number> = {
    "km>mi": 0.621371,
    "mi>km": 1.60934,
    "m>ft": 3.28084,
    "ft>m": 0.3048,
    "kn>kmh": 1.852,
    "kmh>kn": 0.539957,
    "nm>km": 1.852,
    "km>nm": 0.539957,
    "m>yd": 1.09361,
    "yd>m": 0.9144,
  };
  return {
    manifest: {
      name: "unit-convert",
      title: "Unit converter",
      author: AUTHOR,
      version: v,
      permissions: ["command"],
      surfaces: ["web", "terminal", "bbs", "node"],
      remote: true,
      description: "/conv <value> <from> <to> — km/mi/m/ft/yd/kn/kmh/nm + c/f.",
    },
    activate(ctx) {
      ctx.registerCommand("conv", (args) => {
        const [nS, from, to] = args.trim().split(/\s+/);
        const n = Number(nS),
          f = (from ?? "").toLowerCase(),
          t = (to ?? "").toLowerCase();
        if (!isFinite(n) || !f || !t)
          return ["Usage: /conv <value> <from> <to>   e.g.  /conv 100 km mi  |  /conv 20 c f"];
        if (f === "c" && t === "f") return [`${n} C = ${((n * 9) / 5 + 32).toFixed(1)} F`];
        if (f === "f" && t === "c") return [`${n} F = ${(((n - 32) * 5) / 9).toFixed(1)} C`];
        const factor = F[`${f}>${t}`];
        if (factor == null) return [`Can't convert ${from} -> ${to}. Known: km mi m ft yd kn kmh nm, c f.`];
        return [`${n} ${f} = ${(n * factor).toFixed(2)} ${t}`];
      });
    },
  };
}

/** (GP cw) CW/Morse encoder — `/cw <text>` → dot/dash, the send-side companion to the CW decoder. */
export function cwEncoderTool(): Tool {
  return {
    manifest: {
      name: "cw-encoder",
      title: "CW encoder",
      author: AUTHOR,
      version: v,
      permissions: ["command"],
      surfaces: ["web", "terminal"],
      description: "/cw <text> — encode text to Morse (dot/dash).",
    },
    activate(ctx) {
      ctx.registerCommand("cw", (args) => {
        const t = args.trim();
        return t ? [encodeMorse(t)] : ["Usage: /cw <text>"];
      });
    },
  };
}

/** (GP autoname/NAMES.GP) Station DB — classifies every heard station and PUBLISHES it on the IPC bus:
 *  emits `station.seen` {call,type} and provides the `station.type` service other tools call.
 *  A pure IPC *producer* — it renders nothing itself; consumers (info-responder, panels) use the bus. */
export function stationDbTool(registry = new StationRegistry()): Tool {
  return {
    manifest: {
      name: "station-db",
      title: "Station DB (NAMES.GP)",
      author: AUTHOR,
      version: v,
      permissions: ["monitor", "event", "ipc"],
      surfaces: ["terminal", "bbs", "node"],
      description: "Classifies heard stations (NAMES.GP) and shares them on the inter-tool bus.",
    },
    activate(ctx) {
      // Resolve only stations we have actually HEARD (recorded on_frame) — an unheard call → "".
      const classify = (call: string) => {
        const c = String(call).toUpperCase();
        return c ? String(ctx.store.get("sdb." + c) || "") : "";
      };
      ctx.on("on_frame", (p) => {
        const c = String(p.peerCall ?? "").toUpperCase();
        if (!c) return;
        const type = registry.classify(c, { payload: asStr(p.text) });
        ctx.store.set("sdb." + c, type);
        ctx.emit("station.seen", { call: c, type, source: p.source }); // opaque to the host; consumers decide
      });
      // request/response service: any tool can resolve a callsign's station type without knowing about us.
      ctx.provideService("station.type", (arg) =>
        classify(typeof arg === "string" ? arg : ((arg as { call?: string })?.call ?? "")),
      );
    },
  };
}

/** (GP gpserv/gpdir) Info / menu responder — answers a connected peer's read-only queries. Operator-only
 *  commands (/setinfo) are registered `{remote:false}` so a peer can never set them (per-command gate). */
export function infoResponderTool(): Tool {
  return {
    manifest: {
      name: "info-responder",
      title: "Info / menu responder",
      author: AUTHOR,
      version: v,
      permissions: ["command", "panel", "ipc"],
      surfaces: ["terminal", "bbs", "node"],
      remote: true,
      description: "Answers a peer's INFO / MENU / WHOIS <call> (GP gpserv/gpdir).",
    },
    activate(ctx) {
      const info = () => ctx.store.get("info.text") || "APRScaching shack station. Type MENU for commands. 73!";
      ctx.registerCommand("info", () => [info()]);
      ctx.registerCommand("menu", () => ["Commands: INFO  MENU  WHOIS <call>  GRID <loc> [loc]  CONV <n> <from> <to>"]);
      ctx.registerCommand("whois", (args) => {
        const c = args.trim().toUpperCase();
        if (!c) return ["Usage: WHOIS <CALL>"];
        const type = asStr(ctx.callService("station.type", c)); // cross-tool: resolved by station-db over the bus
        return [type ? `${c}: ${type}` : `${c}: not heard yet (enable Station DB to classify).`];
      });
      ctx.registerCommand(
        "setinfo",
        (args) => {
          // operator-only: NOT remote-invokable
          const t = args.trim();
          if (!t) return ["Usage: /setinfo <text peers see>"];
          ctx.store.set("info.text", t.slice(0, 240));
          return ["Info text updated."];
        },
        { remote: false },
      );
      ctx.setPanel({
        title: "Info responder",
        nodes: [
          { kind: "text", text: "Connected peers may send INFO / MENU / WHOIS.", tone: "muted" },
          { kind: "kv", key: "Peer info", value: info() },
        ],
      });
    },
  };
}

/** (GP msg) Away-note responder — when the operator flags away, greet a connecting peer and let them
 *  leave a short note (NOT a mailbox — ephemeral, capped, local). */
export function awayNoteTool(): Tool {
  const KEY = "away.notes";
  return {
    manifest: {
      name: "away-note",
      title: "Away note",
      author: AUTHOR,
      version: v,
      permissions: ["command", "event", "panel"],
      surfaces: ["terminal", "bbs", "node"],
      remote: true,
      description: "Away-message + let a connected peer leave a short note (not a mailbox).",
    },
    activate(ctx) {
      const notes = () => (ctx.store.get(KEY) || "").split("\n").filter(Boolean);
      const rebuild = () => {
        const away = ctx.store.get("away.on") === "1";
        ctx.setPanel({
          title: "Away note",
          nodes: [
            { kind: "badge", text: away ? "AWAY" : "here", tone: away ? "warn" : "ok" },
            ...notes()
              .slice(-8)
              .map((n) => ({ kind: "text", text: n }) as const),
            ...(notes().length ? [] : [{ kind: "text", text: "No notes.", tone: "muted" } as const]),
          ],
        });
      };
      ctx.on("on_connect", (p) => {
        if (ctx.store.get("away.on") === "1")
          p.reply?.(`${ctx.store.get("away.msg") || "Operator is away."} Leave a note with:  NOTE <text>`);
      });
      ctx.registerCommand("note", (args) => {
        // peer-facing: leave a note
        const t = args.trim();
        if (!t) return ["Usage: NOTE <text>"];
        const list = [...notes(), t.slice(0, 120)].slice(-20);
        ctx.store.set(KEY, list.join("\n"));
        rebuild();
        return ["Note saved - 73!"];
      });
      ctx.registerCommand(
        "away",
        (args) => {
          // operator-only
          const a = args.trim();
          if (a.toLowerCase() === "off") {
            ctx.store.set("away.on", "");
            rebuild();
            return ["Away off."];
          }
          ctx.store.set("away.on", "1");
          if (a) ctx.store.set("away.msg", a.slice(0, 160));
          rebuild();
          return [`Away on: "${ctx.store.get("away.msg") || "Operator is away."}"`];
        },
        { remote: false },
      );
      ctx.registerCommand("notes", () => (notes().length ? notes() : ["No notes."]), { remote: false });
      rebuild();
    },
  };
}

/** (GP bimmel) Connect bell — a small on_connect notifier (LinPac "it rang"): logs + reply-pings the
 *  operator's own toast via the host log sink; pairs naturally with watch-alert. */
export function connectBellTool(): Tool {
  return {
    manifest: {
      name: "connect-bell",
      title: "Connect bell",
      author: AUTHOR,
      version: v,
      permissions: ["event", "panel"],
      surfaces: ["terminal", "bbs", "node"],
      description: "Rings (logs a notice) when a station connects.",
    },
    activate(ctx) {
      ctx.on("on_connect", (p) => {
        const who = p.peerCall ? String(p.peerCall) : "a station";
        ctx.store.set("bell.last", `${who}\t${Date.now()}`);
        ctx.log(`*ring* ${who} connected`);
        ctx.setPanel({
          title: "Connect bell",
          nodes: [{ kind: "kv", key: "Last connect", value: `${who} (${ago(Date.now())} ago)` }],
        });
      });
      ctx.setPanel({
        title: "Connect bell",
        nodes: [{ kind: "text", text: "Waiting for a connect...", tone: "muted" }],
      });
    },
  };
}

/** (GP rtt) Link ping — measures round-trip time to the connected peer. The RF round-trip itself is a
 *  surface concern (the terminal times a probe frame and dispatches `on_tick`-style samples); this tool
 *  keeps the rolling stats + panel. Samples arrive over the bus topic `link.rtt` {ms}. */
export function linkPingTool(): Tool {
  return {
    manifest: {
      name: "link-ping",
      title: "Link ping (RTT)",
      author: AUTHOR,
      version: v,
      permissions: ["command", "ipc", "panel"],
      surfaces: ["terminal", "node"],
      description: "Rolling round-trip-time to the connected station (GP rtt).",
    },
    activate(ctx) {
      const samples: number[] = [];
      const rebuild = () => {
        const last = samples.at(-1);
        const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
        ctx.setPanel({
          title: "Link ping",
          nodes: samples.length
            ? [
                { kind: "kv", key: "Last", value: `${last} ms` },
                { kind: "kv", key: "Avg", value: `${avg.toFixed(0)} ms` },
                { kind: "kv", key: "Samples", value: String(samples.length) },
              ]
            : [{ kind: "text", text: "No samples - /ping or feed link.rtt.", tone: "muted" }],
        });
      };
      ctx.subscribe("link.rtt", (data) => {
        const ms = Number((data as { ms?: unknown })?.ms);
        if (isFinite(ms) && ms >= 0) {
          samples.push(ms);
          if (samples.length > 50) samples.shift();
          rebuild();
        }
      });
      ctx.registerCommand("ping", () => {
        ctx.emit("link.ping.request", {});
        return ["Ping requested (the terminal times the round-trip)."];
      });
      rebuild();
    },
  };
}

/** (GP GPAUTO) Scheduled query — batch a connect→waitfor→send→disconnect script against a BBS/cluster and
 *  capture the reply. The tool holds the SCRIPT + the progress panel; the packet terminal owns the actual
 *  connection and offers the `session.script` host-service the tool calls. Operator-only. */
export function schedQueryTool(): Tool {
  return {
    manifest: {
      name: "sched-query",
      title: "Scheduled query (GPAUTO)",
      author: AUTHOR,
      version: v,
      permissions: ["command", "event", "ipc", "panel"],
      surfaces: ["terminal", "node"],
      description: "/gpauto <steps> — run/schedule a connect/waitfor/send/disconnect batch (GP GPAUTO).",
    },
    activate(ctx) {
      const runOnce = (script: string): string => {
        const steps = parseScript(script);
        if (!steps.length) return "No steps. e.g. /gpauto connect HB9W-8; waitfor Cluster; send sh/dx; disconnect";
        const ok = ctx.callService("session.script", { steps }); // the terminal drives it; undefined if no TNC
        return ok ? `Running ${steps.length} steps…` : "Open the packet TNC first (no session service).";
      };
      const render = (st?: ScriptState): void => {
        ctx.setPanel({
          title: "Scheduled query",
          nodes: st
            ? [
                {
                  kind: "kv",
                  key: "Status",
                  value: `${st.status} (${st.step}/${st.total})`,
                  tone: st.status === "error" ? "bad" : st.status === "done" ? "ok" : "accent",
                },
                ...(st.note ? [{ kind: "text", text: st.note, tone: "muted" } as const] : []),
                ...st.captured.slice(-10).map((l) => ({ kind: "text", text: l }) as const),
              ]
            : [{ kind: "text", text: "Idle. /gpauto <steps>  or  /gpauto every <min> <steps>.", tone: "muted" }],
        });
      };
      ctx.subscribe("session.progress", (data) => render(data as ScriptState));
      ctx.registerCommand("gpauto", (args) => {
        const a = args.trim();
        if (!a) {
          const s = ctx.store.get("gpa.script");
          return [
            s
              ? `Script set (${parseScript(s).length} steps). /gpauto run`
              : "No script. /gpauto <steps> or /gpauto every <min> <steps>",
          ];
        }
        if (a.toLowerCase() === "off") {
          ctx.store.set("gpa.every", "0");
          return ["Scheduled query off."];
        }
        const every = a.match(/^every\s+(\d+)\s+([\s\S]+)$/i);
        if (every) {
          ctx.store.set("gpa.every", String(Math.max(1, Number(every[1]))));
          ctx.store.set("gpa.script", every[2]!);
          ctx.store.set("gpa.ticks", "0");
          return [`Scheduled every ${every[1]} min. ${runOnce(every[2]!)}`];
        }
        if (a.toLowerCase() === "run") {
          const s = ctx.store.get("gpa.script");
          return [s ? runOnce(s) : "No stored script — /gpauto <steps> first."];
        }
        ctx.store.set("gpa.script", a);
        return [runOnce(a)];
      });
      ctx.on("on_tick", () => {
        const every = Number(ctx.store.get("gpa.every") || "0");
        if (every <= 0) return;
        const t = Number(ctx.store.get("gpa.ticks") || "0") + 1;
        if (t < every) {
          ctx.store.set("gpa.ticks", String(t));
          return;
        }
        ctx.store.set("gpa.ticks", "0");
        const s = ctx.store.get("gpa.script");
        if (s) runOnce(s);
      });
      render();
    },
  };
}

/** Map waypoints — `/wp <locator|lat,lon> [label]` drops a marker on the map via
 *  the declarative `map` layer; `/wpclear` empties it. Demonstrates the `map` capability end-to-end. */
export function mapWaypointsTool(): Tool {
  return {
    manifest: {
      name: "map-waypoints",
      title: "Map waypoints",
      author: AUTHOR,
      version: v,
      permissions: ["command", "map"],
      surfaces: ["web", "map"],
      description: "/wp <locator|lat,lon> [label] — drop a marker on the map; /wpclear to reset.",
    },
    activate(ctx) {
      const pts: { lat: number; lon: number; label?: string }[] = [];
      const push = () =>
        ctx.setMapLayer({ id: "waypoints", points: pts.map((p) => ({ ...p, tone: "accent" as const })) });
      ctx.registerCommand("wp", (args) => {
        const [loc, ...rest] = args.trim().split(/\s+/);
        const label = rest.join(" ") || undefined;
        let p = gridToLatLon(loc ?? "");
        if (!p) {
          const m = (loc ?? "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
          if (m) p = { lat: Number(m[1]), lon: Number(m[2]) };
        }
        if (!p || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return ["Usage: /wp <locator|lat,lon> [label]"];
        pts.push({ ...p, label });
        push();
        return [`Waypoint ${pts.length}: ${p.lat.toFixed(4)},${p.lon.toFixed(4)}${label ? ` (${label})` : ""}`];
      });
      ctx.registerCommand("wpclear", () => {
        pts.length = 0;
        push();
        return ["Waypoints cleared."];
      });
    },
  };
}

/** (GP GIP) Block art — render CP437/ANSI art as a `blocks` panel (the "graphic" in Graphic Packet).
 *  `/art <text>` renders text as a monochrome phosphor grid; any tool can also push an image by emitting
 *  `render.blocks` on the bus ({text} or a full blocks spec) — a generic renderer, function-agnostic. */
export function blockArtTool(): Tool {
  const SAMPLE = [
    '  .-"""-.',
    " / .===. \\",
    " \\/ 6 6 \\/",
    " ( \\___/ )   APRScaching",
    "  \\_____/    de OE8APR",
  ].join("\n");
  return {
    manifest: {
      name: "block-art",
      title: "Block art (GIP)",
      author: AUTHOR,
      version: v,
      permissions: ["command", "panel", "ipc"],
      surfaces: ["web", "terminal", "bbs"],
      description: "Render CP437/ANSI block art (GP GIP). /art <text>, or push render.blocks on the bus.",
    },
    activate(ctx) {
      const showText = (text: string) => ctx.setPanel({ title: "Block art", nodes: [parseBlocks(text)] });
      ctx.registerCommand("art", (args) => {
        if (!args.trim()) {
          showText(SAMPLE);
          return ["Rendered the sample. /art <text> to render your own CP437/ANSI art."];
        }
        showText(args.replace(/\\n/g, "\n"));
        return ["Rendered."];
      });
      // Any tool (incl. a sandboxed import) can push an image: emit("render.blocks", { text }) or a full
      // { cols, cells } spec. Sanitised before display since the payload may be third-party.
      ctx.subscribe("render.blocks", (data) => {
        const d = (data ?? {}) as { text?: unknown; cols?: unknown; cells?: unknown };
        if (typeof d.text === "string") showText(d.text);
        else if (Array.isArray(d.cells))
          ctx.setPanel(
            sanitizePanel({ title: "Block art", nodes: [{ kind: "blocks", cols: d.cols, cells: d.cells }] }),
          );
      });
      showText(SAMPLE);
    },
  };
}

/** Beacon scheduler — a /beacon command that schedules a comment beacon (TX-gated by the host). */
export function beaconSchedulerTool(): Tool {
  return {
    manifest: {
      name: "beacon-scheduler",
      title: "Beacon scheduler",
      author: AUTHOR,
      version: v,
      permissions: ["command", "beacon"],
      surfaces: ["terminal"],
      description: "Schedule a periodic comment beacon (TX-gated).",
    },
    activate(ctx) {
      ctx.registerCommand("beacon", (args) => {
        const [everyMin, ...rest] = args.split(/\s+/);
        const intervalSec = Math.max(60, (Number(everyMin) || 30) * 60);
        ctx.scheduleBeacon({ comment: rest.join(" ") || "APRScaching", intervalSec });
        return [`Beacon scheduled every ${intervalSec / 60} min.`];
      });
    },
  };
}

/** Built-in signal decoders — the CW + PSK31 decoders (pure; audio front-end is browser-side). */
export function decoderTools(): Tool {
  return {
    manifest: {
      name: "digimode-decoders",
      title: "PSK31 + CW decoders",
      author: AUTHOR,
      version: v,
      permissions: ["decoder"],
      surfaces: ["web"],
      description: "Decode PSK31 varicode + CW (Morse) — the audio-cache decoders.",
    },
    activate(ctx) {
      ctx.addDecoder({ id: "cw", label: "CW (Morse)", kind: "cw", decode: decodeMorse });
      ctx.addDecoder({ id: "psk31", label: "PSK31", kind: "psk31", decode: decodeVaricode });
    },
  };
}

/** APRS SSID reference — a `panel`-capability tool that renders a declarative table in the Tools app.
 *  Demonstrates the panel extension point: a tool presents a real UI region without touching the DOM. */
export function ssidReferenceTool(): Tool {
  return {
    manifest: {
      name: "aprs-ssid-guide",
      title: "APRS SSID guide",
      author: AUTHOR,
      version: v,
      permissions: ["panel"],
      surfaces: ["web", "terminal", "bbs"],
      description: "A quick reference of the conventional APRS -SSID assignments.",
    },
    activate(ctx) {
      ctx.setPanel({
        title: "Conventional APRS SSIDs",
        nodes: [
          { kind: "text", text: "Widely-followed conventions (not enforced by APRS-IS).", tone: "muted" },
          {
            kind: "table",
            head: ["SSID", "Typical use"],
            rows: [
              ["-0", "primary / home station"],
              ["-1", "generic / RX-only IGate"],
              ["-5", "phone / other networks (DMR, D-STAR)"],
              ["-7", "handheld / HT"],
              ["-9", "mobile / vehicle"],
              ["-10", "IGate / internet"],
              ["-13", "weather station"],
              ["-15", "generic additional"],
            ],
          },
        ],
      });
    },
  };
}

/** The full curated built-in set the host ships (all OFF by default). */
export function builtinTools(): Tool[] {
  return [
    colouriserTool(),
    macroPackTool(),
    autoResponderTool(),
    beaconSchedulerTool(),
    decoderTools(),
    ssidReferenceTool(),
    watchAlertTool(),
    mheardTool(),
    autoStatusTool(),
    gridTool(),
    sevenPlusTool(),
    // GP-archive tools: remote responders + IPC producer/consumers.
    unitConverterTool(),
    cwEncoderTool(),
    stationDbTool(),
    infoResponderTool(),
    awayNoteTool(),
    connectBellTool(),
    linkPingTool(),
    schedQueryTool(),
    blockArtTool(),
    mapWaypointsTool(),
  ];
}
