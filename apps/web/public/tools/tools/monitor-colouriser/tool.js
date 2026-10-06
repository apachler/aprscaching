// SPDX-License-Identifier: MIT
// Monitor colouriser 1.1.0, built by scripts/build.mjs from tools/monitor-colouriser/src, lib/ and the
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

  // tools/monitor-colouriser/src/index.js
  var MAX_STATIONS = 2e3;
  var PUBLISH_MS = 1e3;
  var registry = new StationRegistry();
  var types = /* @__PURE__ */ new Map();
  var timer = null;
  function publish() {
    timer = null;
    tool.setColourRules([...types].map(([src, type]) => ({ src, colorVar: `--st-${type}` })));
  }
  tool.on("on_frame", (p) => {
    const call = callOf(p.peerCall);
    if (!call) return;
    const type = registry.classify(call, { dest: asStr(p.dst), payload: asStr(p.text) });
    if (types.get(call) === type) return;
    types.delete(call);
    types.set(call, type);
    if (types.size > MAX_STATIONS) types.delete(types.keys().next().value);
    timer ??= setTimeout(publish, PUBLISH_MS);
  });
})();
