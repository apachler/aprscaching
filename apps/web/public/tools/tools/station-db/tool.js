// SPDX-License-Identifier: MIT
// Station DB (NAMES.GP) 1.1.1, built by scripts/build.mjs from tools/station-db/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // vendor/aprscaching/packages/packet/src/names.ts
  var up = (s) => s.trim().toUpperCase();
  var ssidOf = (call) => {
    const m = /-(\d+)$/.exec(up(call));
    return m ? Number(m[1]) : 0;
  };
  function classifyStation(call, h = {}) {
    const dest = h.dest ? up(h.dest) : "";
    const sym = h.symbol ?? "";
    const pay = h.payload ?? "";
    if (h.ourTocalls?.some((t) => dest === up(t) || dest.startsWith(up(t)))) return "service";
    if (sym.endsWith("_") || /^[!=/@].*_\d{3}\/\d{3}/.test(pay) || /^_\d{8}c/.test(pay)) return "weather";
    if (sym.endsWith("#")) return "digi";
    if (/\bNODES?\b/.test(pay) || dest === "NODES") return "node";
    if (ssidOf(call) === 10) return "igate";
    if (/^[!=/@`'].+/.test(pay)) return "beacon";
    return "user";
  }
  var StationRegistry = class {
    overrides = /* @__PURE__ */ new Map();
    constructor(seed = {}) {
      for (const [k, v] of Object.entries(seed)) this.overrides.set(up(k), v);
    }
    /** Pin a callsign to a type (GP's editable NAMES table). Pass null to clear. */
    set(call, type) {
      if (type) this.overrides.set(up(call), type);
      else this.overrides.delete(up(call));
    }
    get(call) {
      return this.overrides.get(up(call));
    }
    /** Resolve a station's type: an explicit override, else auto-classify the frame hints. */
    classify(call, hints) {
      return this.overrides.get(up(call)) ?? classifyStation(call, hints);
    }
    /** Export the overrides for persistence. */
    toJSON() {
      return Object.fromEntries(this.overrides);
    }
  };

  // lib/text.js
  var asStr = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  var callOf = (v) => asStr(v).trim().toUpperCase();

  // tools/station-db/src/index.js
  var KEPT = 5e3;
  var registry = new StationRegistry();
  var heard = /* @__PURE__ */ new Map();
  tool.on("on_frame", (p) => {
    const call = callOf(p.peerCall);
    if (!call) return;
    const type = registry.classify(call, { dest: asStr(p.dst), payload: asStr(p.text) });
    heard.delete(call);
    heard.set(call, type);
    if (heard.size > KEPT) heard.delete(heard.keys().next().value);
    tool.emit("station.seen", { call, type, source: p.source });
  });
  tool.provide("station.type", (arg) => heard.get(callOf(typeof arg === "string" ? arg : arg?.call)) ?? "");
})();
