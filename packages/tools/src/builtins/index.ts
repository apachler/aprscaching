/**
 * builtins/index.ts — the curated built-in Tools (docs/27 B.3). Each is a plain module implementing the
 * Tool interface (no sandbox needed — they're first-party + trusted), demonstrating every extension
 * point: a monitor colouriser (off the NAMES.GP registry), a CTEXT macro pack (/commands), an
 * auto-responder (on_connect greeting), a beacon scheduler (TX-gated), and the F-5 PSK31 + CW decoders.
 * The event payloads may carry a `reply` callback so a tool can answer a connected session generically.
 */
import { StationRegistry } from "@aprsweb/packet";
import type { Tool } from "../host.js";
import type { PanelSpec } from "../panel.js";
import { decodeMorse } from "../decoders/morse.js";
import { decodeVaricode } from "../decoders/psk31.js";
import { decode7plus } from "../decoders/sevenplus.js";

const AUTHOR = "OE8APR";
const v = "1.0.0";

/** Monitor colouriser — tags each heard frame with its NAMES.GP station-type colour token. */
export function colouriserTool(registry = new StationRegistry()): Tool {
  return {
    manifest: { name: "monitor-colouriser", title: "Monitor colouriser", author: AUTHOR, version: v, permissions: ["monitor"], surfaces: ["terminal"], description: "Colours heard traffic by NAMES.GP station type." },
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
  const macros: Record<string, string> = { cq: "CQ CQ CQ de {call} k", "73": "73 es gud dx de {call}", qth: "QTH is {grid}" };
  return {
    manifest: { name: "ctext-macros", title: "CTEXT macro pack", author: AUTHOR, version: v, permissions: ["command"], surfaces: ["terminal", "bbs"], description: "Canned /cq /73 /qth text macros." },
    activate(ctx) {
      for (const [word, text] of Object.entries(macros)) ctx.registerCommand(word, () => [text]);
    },
  };
}

/** Auto-responder — GP PMS-style: greet an incoming connect, personalised with the peer's callsign
 *  (docs/28 A — the event now carries peerCall/myCall/station + a reply sink). */
export function autoResponderTool(): Tool {
  return {
    manifest: { name: "auto-responder", title: "Auto-responder", author: AUTHOR, version: v, permissions: ["event"], surfaces: ["terminal", "bbs", "node"], description: "Greets an incoming connect (QTEXT/PMS style)." },
    activate(ctx) {
      ctx.on("on_connect", (p) => {
        const who = p.peerCall ? ` ${p.peerCall}` : "";
        p.reply?.(`Welcome${who} - this is${p.myCall ? ` ${p.myCall}` : " an APRScaching"} auto-responder. Type H for help.`);
      });
    },
  };
}

// ---- small pure helpers for the tools below ----
// Maidenhead pair bases: field 18 · square 10 · subsquare 24 · ext-square 10 · ext-subsquare 24 (F-7).
const MH_BASES = [18, 10, 24, 10, 24];
/** Maidenhead locator → lat/lon (centre of the smallest cell); accepts 4/6/8/10-char. Null if malformed. */
function gridToLatLon(loc: string): { lat: number; lon: number } | null {
  const g = loc.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2}([A-X]{2})?)?)?$/.test(g)) return null;
  const pairs = g.match(/../g)!;
  let lon = -180, lat = -90, lonCell = 360, latCell = 180;
  for (let p = 0; p < pairs.length; p++) {
    lonCell /= MH_BASES[p]!; latCell /= MH_BASES[p]!;
    const base = p === 0 || p % 2 === 0 ? 65 : 48;
    lon += (pairs[p]!.charCodeAt(0) - base) * lonCell;
    lat += (pairs[p]!.charCodeAt(1) - base) * latCell;
  }
  return { lat: lat + latCell / 2, lon: lon + lonCell / 2 };
}
/** Great-circle distance (km) + initial bearing (°) between two points. */
function distBearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): { km: number; bearing: number } {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const la1 = a.lat * rad, la2 = b.lat * rad;
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

/** (Tool 1) Watch/alert — highlight + log heard callsigns you `/watch` (GP/LinPac WATCH/CATCH). */
export function watchAlertTool(): Tool {
  return {
    manifest: { name: "watch-alert", title: "Watch & alert", author: AUTHOR, version: v, permissions: ["command", "monitor", "panel"], surfaces: ["terminal", "web"], description: "Highlight + log heard callsigns you /watch; see hits in a panel." },
    activate(ctx) {
      const watched = () => ctx.store.keys().filter((k) => k.startsWith("watch.") && ctx.store.get(k)).map((k) => k.slice(6));
      const rebuild = () => {
        const rows = watched().map((c) => [c, (() => { const h = ctx.store.get("watchhit." + c); return h ? `${ago(Number(h))} ago` : "—"; })()]);
        ctx.setPanel({ title: "Watch", nodes: rows.length ? [{ kind: "table", head: ["Call", "Last heard"], rows }] : [{ kind: "text", text: "No calls watched — /watch <CALL>", tone: "muted" }] });
      };
      ctx.registerCommand("watch", (args) => {
        const c = args.trim().toUpperCase();
        if (!c) { const l = watched(); return [l.length ? `Watching: ${l.join(" ")}` : "Watching nothing. /watch <CALL>"]; }
        ctx.store.set("watch." + c, "1"); rebuild(); return [`Watching ${c}.`];
      });
      ctx.registerCommand("unwatch", (args) => { const c = args.trim().toUpperCase(); ctx.store.set("watch." + c, ""); rebuild(); return [`Unwatched ${c}.`]; });
      ctx.addColouriser((line) => {
        const call = line.src.toUpperCase(), base = call.split("-")[0]!;
        if (ctx.store.get("watch." + call) || ctx.store.get("watch." + base)) { ctx.store.set("watchhit." + call, String(Date.now())); return { colorVar: "--warn" }; }
        return null;
      });
      rebuild();
    },
  };
}

/** (Tool 2) MHeard — a rolling recently-heard-stations panel (GP/LinPac MHEARD). */
export function mheardTool(): Tool {
  return {
    manifest: { name: "mheard", title: "MHeard", author: AUTHOR, version: v, permissions: ["monitor", "event", "panel"], surfaces: ["terminal", "web"], description: "Rolling list of recently heard stations (updates as traffic arrives + each minute)." },
    activate(ctx) {
      const rebuild = () => {
        const rows = ctx.store.keys().filter((k) => k.startsWith("mh.")).map((k) => ({ call: k.slice(3), ts: Number(ctx.store.get(k)) }))
          .sort((a, b) => b.ts - a.ts).slice(0, 12).map((x) => [x.call, `${ago(x.ts)} ago`]);
        ctx.setPanel({ title: "MHeard", nodes: rows.length ? [{ kind: "table", head: ["Station", "Heard"], rows }] : [{ kind: "text", text: "Nothing heard yet.", tone: "muted" }] });
      };
      ctx.addColouriser((line) => { const c = line.src.toUpperCase(); const had = !!ctx.store.get("mh." + c); ctx.store.set("mh." + c, String(Date.now())); if (!had) rebuild(); return null; });
      ctx.on("on_tick", rebuild);
      rebuild();
    },
  };
}

/** (Tool 4) Auto-status — periodically transmit a status line via on_tick (GP timed macros); TX-gated. */
export function autoStatusTool(): Tool {
  return {
    manifest: { name: "auto-status", title: "Auto-status", author: AUTHOR, version: v, permissions: ["command", "event", "tx"], surfaces: ["terminal"], description: "/autostatus <min> <text> — periodically transmit a status (TX-gated)." },
    activate(ctx) {
      ctx.registerCommand("autostatus", (args) => {
        const parts = args.trim().split(/\s+/);
        if (parts[0] === "off" || !parts[0]) { ctx.store.set("as.min", "0"); return ["Auto-status off."]; }
        const min = Math.max(1, Number(parts[0]) || 10), text = parts.slice(1).join(" ") || "APRScaching";
        ctx.store.set("as.min", String(min)); ctx.store.set("as.text", text); ctx.store.set("as.ticks", "0");
        return [`Auto-status every ${min} min: "${text}" (TX-gated).`];
      });
      ctx.on("on_tick", () => {
        const min = Number(ctx.store.get("as.min") || "0"); if (min <= 0) return;
        const t = Number(ctx.store.get("as.ticks") || "0") + 1;
        if (t < min) { ctx.store.set("as.ticks", String(t)); return; }
        ctx.store.set("as.ticks", "0");
        ctx.log(ctx.requestTx(ctx.store.get("as.text") || "APRScaching") ? "auto-status sent" : "auto-status held (TX gate closed)");
      });
    },
  };
}

/** (Tool 5) Grid & bearing — distance + bearing between Maidenhead locators; result shown in a panel. */
export function gridTool(): Tool {
  const panel = (a: string, pa: { lat: number; lon: number }, b?: string, pb?: { lat: number; lon: number; km: number; bearing: number }): PanelSpec => ({
    title: "Grid & bearing",
    nodes: [
      { kind: "kv", key: a.toUpperCase(), value: `${pa.lat.toFixed(4)}, ${pa.lon.toFixed(4)}` },
      ...(b && pb ? [
        { kind: "kv", key: b.toUpperCase(), value: `${pb.lat.toFixed(4)}, ${pb.lon.toFixed(4)}` } as const,
        { kind: "kv", key: "Distance", value: `${pb.km.toFixed(0)} km`, tone: "accent" } as const,
        { kind: "kv", key: "Bearing", value: `${pb.bearing.toFixed(0)}°`, tone: "accent" } as const,
      ] : []),
    ],
  });
  return {
    manifest: { name: "grid-bearing", title: "Grid & bearing", author: AUTHOR, version: v, permissions: ["command", "panel"], surfaces: ["web", "terminal"], description: "/grid <locA> [locB] — distance + bearing between two Maidenhead locators." },
    activate(ctx) {
      ctx.registerCommand("grid", (args) => {
        const [a, b] = args.trim().split(/\s+/);
        const pa = gridToLatLon(a ?? "");
        if (!pa) return ["Usage: grid <locatorA> [locatorB]   e.g.  grid JN76jx JO30"];
        if (!b) { ctx.setPanel(panel(a!, pa)); return [`${a!.toUpperCase()} = ${pa.lat.toFixed(4)}, ${pa.lon.toFixed(4)}`]; }
        const pb = gridToLatLon(b); if (!pb) return [`Bad locator: ${b}`];
        const db = distBearing(pa, pb);
        ctx.setPanel(panel(a!, pa, b, { ...pb, ...db }));
        return [`${a!.toUpperCase()} → ${b.toUpperCase()}: ${db.km.toFixed(0)} km, bearing ${db.bearing.toFixed(0)}°`];
      });
    },
  };
}

/** (Tool 8) 7PLUS reassembler — parse + stitch multi-part 7plus messages (decoder capability). */
export function sevenPlusTool(): Tool {
  return {
    manifest: { name: "sevenplus", title: "7PLUS reassembler", author: AUTHOR, version: v, permissions: ["decoder"], surfaces: ["web"], description: "Parse + reassemble multi-part 7plus messages (file / part / completeness)." },
    activate(ctx) { ctx.addDecoder({ id: "7plus", label: "7PLUS", kind: "7plus", decode: decode7plus }); },
  };
}

/** Beacon scheduler — a /beacon command that schedules a comment beacon (TX-gated by the host). */
export function beaconSchedulerTool(): Tool {
  return {
    manifest: { name: "beacon-scheduler", title: "Beacon scheduler", author: AUTHOR, version: v, permissions: ["command", "beacon"], surfaces: ["terminal"], description: "Schedule a periodic comment beacon (TX-gated)." },
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

/** Built-in signal decoders — the F-5 CW + PSK31 decoders (pure; audio front-end is browser-side). */
export function decoderTools(): Tool {
  return {
    manifest: { name: "digimode-decoders", title: "PSK31 + CW decoders", author: AUTHOR, version: v, permissions: ["decoder"], surfaces: ["web"], description: "Decode PSK31 varicode + CW (Morse) — the audio-cache F-5 decoders." },
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
    manifest: { name: "aprs-ssid-guide", title: "APRS SSID guide", author: AUTHOR, version: v, permissions: ["panel"], surfaces: ["web", "terminal", "bbs"], description: "A quick reference of the conventional APRS -SSID assignments." },
    activate(ctx) {
      ctx.setPanel({
        title: "Conventional APRS SSIDs",
        nodes: [
          { kind: "text", text: "Widely-followed conventions (not enforced by APRS-IS).", tone: "muted" },
          { kind: "table", head: ["SSID", "Typical use"], rows: [
            ["-0", "primary / home station"],
            ["-1", "generic / RX-only IGate"],
            ["-5", "phone / other networks (DMR, D-STAR)"],
            ["-7", "handheld / HT"],
            ["-9", "mobile / vehicle"],
            ["-10", "IGate / internet"],
            ["-13", "weather station"],
            ["-15", "generic additional"],
          ] },
        ],
      });
    },
  };
}

/** The full curated built-in set the host ships (all OFF by default). */
export function builtinTools(): Tool[] {
  return [
    colouriserTool(), macroPackTool(), autoResponderTool(), beaconSchedulerTool(), decoderTools(), ssidReferenceTool(),
    watchAlertTool(), mheardTool(), autoStatusTool(), gridTool(), sevenPlusTool(),
  ];
}
