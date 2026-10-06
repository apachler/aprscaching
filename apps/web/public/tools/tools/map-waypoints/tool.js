// SPDX-License-Identifier: MIT
// Map waypoints 1.0.0, built by scripts/build.mjs from tools/map-waypoints/src, lib/ and the
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

  // tools/map-waypoints/src/index.js
  var MAX_POINTS = 500;
  var points = [];
  var push = () => tool.setMapLayer({ id: "waypoints", points: points.map((p) => ({ ...p, tone: "accent" })) });
  register({
    commands: {
      wp: (args) => {
        const [loc, ...rest] = args.trim().split(/\s+/);
        const label = rest.join(" ") || void 0;
        let p = gridToLatLon(loc ?? "");
        if (!p) {
          const m = (loc ?? "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
          if (m) p = { lat: Number(m[1]), lon: Number(m[2]) };
        }
        if (!p || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return ["Usage: /wp <locator|lat,lon> [label]"];
        points.push({ ...p, ...label ? { label } : {} });
        if (points.length > MAX_POINTS) points.shift();
        push();
        return [`Waypoint ${points.length}: ${p.lat.toFixed(4)},${p.lon.toFixed(4)}${label ? ` (${label})` : ""}`];
      },
      wpclear: () => {
        points.length = 0;
        push();
        return ["Waypoints cleared."];
      }
    }
  });
})();
