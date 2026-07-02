// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-time geofencing smoke (M2): subscribe over WebSocket, ingest a position near a cache, and
// assert a "near_cache" prompt arrives — and that prompts are addressed to the right callsign.
// Uses Node's global WebSocket (Node 22+). Works against the Worker (DO) or Node (rooms).
//
//   BASE=http://127.0.0.1:8787 node tools/smoke/geofence.mjs

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function ok(name, cond, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", "x-ingest-secret": SECRET, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function waitHealthy() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) return true; } catch {} await sleep(500); }
  return false;
}
const position = (src, lat, lon) => ({
  packets: [{ src, path: ["TCPIP*", "qAC", "T2"], payload: "=pos", kind: "position",
    parsed: { lat, lon, symbol: ">" }, heardVia: "aprs_is", port: "aprs-is", ts: now() }],
});

console.log(`geofence: ${BASE}`);
ok("healthy", await waitHealthy());

// a cache somewhere quiet
const LAT = 47.5, LON = 15.5;
const created = await call("POST", "/api/caches", { title: "Geofence Cache " + now(), type: "single", lat: LAT, lon: LON, ownerCall: "OE8APR" });
ok("created a cache", created.status === 201, JSON.stringify(created.data));
const cacheId = created.data?.cache?.id;

// subscribe as GEO1 over WebSocket
const wsUrl = BASE.replace(/^http/, "ws") + "/ws?region=global";
const ws = new WebSocket(wsUrl);
const got = [];
ws.addEventListener("message", (e) => { try { got.push(JSON.parse(e.data)); } catch {} });
const opened = await new Promise((res) => { ws.addEventListener("open", () => res(true)); ws.addEventListener("error", () => res(false)); });
ok("websocket connected", opened);
ws.send(JSON.stringify({ type: "subscribe", bbox: [LON - 1, LAT - 1, LON + 1, LAT + 1], maxAgeSec: 3600, callsign: "GEO1" }));
await sleep(500);

// GEO1 walks into the cache radius -> expect a near_cache prompt for this cache + a station delta
await call("POST", "/ingest", position("GEO1", LAT + 0.0005, LON), { "x-ingest-secret": SECRET });
await sleep(1200);
const prompt = got.find((m) => m.type === "near_cache" && m.cacheId === cacheId);
ok("received near_cache prompt for the cache", !!prompt, JSON.stringify(got));
ok("prompt carries code + distance", !!prompt && /^AC-/.test(prompt.code ?? "") && typeof prompt.distanceM === "number", JSON.stringify(prompt));
ok("received a station delta for GEO1", got.some((m) => m.type === "station" && m.callsign === "GEO1"));

// a DIFFERENT callsign near the cache -> GEO1 must NOT get that prompt (it's addressed to OTHER)
got.length = 0;
await call("POST", "/ingest", position("OTHER", LAT + 0.0004, LON), { "x-ingest-secret": SECRET });
await sleep(1200);
ok("no near_cache leaks to the wrong callsign", !got.some((m) => m.type === "near_cache"), JSON.stringify(got));
ok("but station deltas still broadcast in-bbox", got.some((m) => m.type === "station" && m.callsign === "OTHER"));

try { ws.close(); } catch {}
console.log(failures ? `\nGEOFENCE FAILED (${failures})` : "\nGEOFENCE CONFORMANCE PASSED");
process.exit(failures ? 1 : 0);
