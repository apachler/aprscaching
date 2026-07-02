/**
 * builtins/index.ts — the curated built-in Tools (docs/27 B.3). Each is a plain module implementing the
 * Tool interface (no sandbox needed — they're first-party + trusted), demonstrating every extension
 * point: a monitor colouriser (off the NAMES.GP registry), a CTEXT macro pack (/commands), an
 * auto-responder (on_connect greeting), a beacon scheduler (TX-gated), and the F-5 PSK31 + CW decoders.
 * The event payloads may carry a `reply` callback so a tool can answer a connected session generically.
 */
import { StationRegistry } from "@aprsweb/packet";
import type { Tool } from "../host.js";
import { decodeMorse } from "../decoders/morse.js";
import { decodeVaricode } from "../decoders/psk31.js";

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

/** Auto-responder — GP PMS-style: greet an incoming connect (payload may carry a reply callback). */
export function autoResponderTool(greeting = "Welcome - this is an APRScaching auto-responder. Type H for help."): Tool {
  return {
    manifest: { name: "auto-responder", title: "Auto-responder", author: AUTHOR, version: v, permissions: ["event"], surfaces: ["terminal", "bbs", "node"], description: "Greets an incoming connect (QTEXT/PMS style)." },
    activate(ctx) {
      ctx.on("on_connect", (payload) => { (payload as { reply?: (t: string) => void })?.reply?.(greeting); });
    },
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
  return [colouriserTool(), macroPackTool(), autoResponderTool(), beaconSchedulerTool(), decoderTools(), ssidReferenceTool()];
}
