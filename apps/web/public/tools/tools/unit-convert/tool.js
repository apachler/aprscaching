// SPDX-License-Identifier: MIT
// Unit converter 1.1.0, built by scripts/build.mjs from tools/unit-convert/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // tools/unit-convert/src/index.js
  var FACTOR = {
    "km>mi": 0.621371,
    "mi>km": 1.60934,
    "m>ft": 3.28084,
    "ft>m": 0.3048,
    "kn>kmh": 1.852,
    "kmh>kn": 0.539957,
    "nm>km": 1.852,
    "km>nm": 0.539957,
    "m>yd": 1.09361,
    "yd>m": 0.9144
  };
  register({
    commands: {
      conv: {
        remote: true,
        run: (args) => {
          const [nS, from, to] = args.trim().split(/\s+/);
          const n = Number(nS);
          const f = (from ?? "").toLowerCase();
          const t = (to ?? "").toLowerCase();
          if (!isFinite(n) || !f || !t) return ["Usage: /conv <value> <from> <to>   e.g.  /conv 100 km mi  |  /conv 20 c f"];
          if (f === "c" && t === "f") return [`${n} C = ${(n * 9 / 5 + 32).toFixed(1)} F`];
          if (f === "f" && t === "c") return [`${n} F = ${((n - 32) * 5 / 9).toFixed(1)} C`];
          const factor = FACTOR[`${f}>${t}`];
          if (factor == null) return [`Can't convert ${from} -> ${to}. Known: km mi m ft yd kn kmh nm, c f.`];
          return [`${n} ${f} = ${(n * factor).toFixed(2)} ${t}`];
        }
      }
    }
  });
})();
