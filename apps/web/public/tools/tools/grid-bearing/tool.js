// SPDX-License-Identifier: MIT
// Grid & bearing 1.1.0, built by scripts/build.mjs from tools/grid-bearing/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // lib/geo.js
  var MH_BASES = [18, 10, 24, 10, 24];
  function gridToLatLon(loc) {
    const g = String(loc).trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2}([A-X]{2})?)?)?$/.test(g)) return null;
    const pairs = g.match(/../g);
    let lon = -180;
    let lat = -90;
    let lonCell = 360;
    let latCell = 180;
    for (let p = 0; p < pairs.length; p++) {
      lonCell /= MH_BASES[p];
      latCell /= MH_BASES[p];
      const base = p === 0 || p % 2 === 0 ? 65 : 48;
      lon += (pairs[p].charCodeAt(0) - base) * lonCell;
      lat += (pairs[p].charCodeAt(1) - base) * latCell;
    }
    return { lat: lat + latCell / 2, lon: lon + lonCell / 2 };
  }
  function distBearing(a, b) {
    const R = 6371;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const la1 = a.lat * rad;
    const la2 = b.lat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return { km, bearing: (Math.atan2(y, x) / rad + 360) % 360 };
  }

  // tools/grid-bearing/src/index.js
  var fix = (p) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
  function panel(a, pa, b, pb) {
    return {
      title: "Grid & bearing",
      nodes: [
        { kind: "kv", key: a.toUpperCase(), value: fix(pa) },
        ...b && pb ? [
          { kind: "kv", key: b.toUpperCase(), value: fix(pb) },
          { kind: "kv", key: "Distance", value: `${pb.km.toFixed(0)} km`, tone: "accent" },
          { kind: "kv", key: "Bearing", value: `${pb.bearing.toFixed(0)}°`, tone: "accent" }
        ] : []
      ]
    };
  }
  register({
    commands: {
      grid: {
        remote: true,
        run: (args) => {
          const [a, b] = args.trim().split(/\s+/);
          const pa = gridToLatLon(a ?? "");
          if (!pa) return ["Usage: grid <locatorA> [locatorB]   e.g.  grid JN76jx JO30"];
          if (!b) {
            tool.setPanel(panel(a, pa));
            return [`${a.toUpperCase()} = ${fix(pa)}`];
          }
          const pb = gridToLatLon(b);
          if (!pb) return [`Bad locator: ${b}`];
          const db = distBearing(pa, pb);
          tool.setPanel(panel(a, pa, b, { ...pb, ...db }));
          return [`${a.toUpperCase()} → ${b.toUpperCase()}: ${db.km.toFixed(0)} km, bearing ${db.bearing.toFixed(0)}°`];
        }
      }
    }
  });
})();
