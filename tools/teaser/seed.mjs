// Seed a realistic demo dataset (Graz/Styria) for the teaser crawl.
// Idempotent-ish: skips caches whose title already exists.
const API = process.env.API_BASE ?? "http://127.0.0.1:8787";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
const now = () => Math.floor(Date.now() / 1000);

const j = (method, path, body, headers = {}) =>
  fetch(API + path, {
    method,
    // the ingest secret authorises the body ownerCall/loggerCall on write endpoints (actor())
    headers: { "content-type": "application/json", "x-ingest-secret": SECRET, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));

const CACHES = [
  { title: "Schlossberg Clock Tower", type: "single", lat: 47.0735, lon: 15.4378, difficulty: 1.5, terrain: 2, ownerCall: "OE8APR", hint: "behind the clock face", description: "The classic Grazer Uhrturm starter cache — beacon your position to verify the find." },
  { title: "Mur Riverwalk", type: "two_stage", lat: 47.0700, lon: 15.4300, difficulty: 2, terrain: 1.5, ownerCall: "OE8APR", hint: "stage 1 at the bridge" },
  { title: "Plabutsch Park", type: "pota", lat: 47.0820, lon: 15.3820, difficulty: 2.5, terrain: 3, ownerCall: "OE1POTA" },
  { title: "Eggenberg Gardens", type: "traditional", lat: 47.0735, lon: 15.3900, difficulty: 1.5, terrain: 1.5, ownerCall: "DL2GRZ", hint: "by the peacocks" },
  { title: "Murinsel Echo", type: "audio", lat: 47.0725, lon: 15.4335, difficulty: 2, terrain: 2, ownerCall: "OE8APR", description: "Listen for the audio clue on the island." },
  { title: "OE8XYZ Rover", type: "aprs_living", lat: 47.0620, lon: 15.4050, difficulty: 3, terrain: 2.5, ownerCall: "OE8APR", stationCall: "OE8XYZ-9", description: "A living cache: find the rover while it beacons." },
  { title: "Hilmteich Loop", type: "multi", lat: 47.0820, lon: 15.4640, difficulty: 2.5, terrain: 2, ownerCall: "OE5MUL" },
  { title: "Schoeckl OE/ST-027", type: "sota", lat: 47.1980, lon: 15.4660, difficulty: 3.5, terrain: 4, ownerCall: "OE6SOTA", description: "SOTA summit — activate from the top." },
];

const existing = (await j("GET", "/api/caches?bbox=-180,-90,180,90")).data.caches ?? [];
const have = new Set(existing.map((c) => c.title));
const idByTitle = new Map(existing.map((c) => [c.title, c.id]));

for (const c of CACHES) {
  if (have.has(c.title)) { console.log("skip (exists):", c.title); continue; }
  const r = await j("POST", "/api/caches", c);
  if (r.ok) { idByTitle.set(c.title, r.data.cache.id); console.log("created:", r.data.cache.code, c.title); }
  else console.error("FAILED:", c.title, r.status, r.data);
}

// Rich logbook on the hero cache: Tier B (app geo), Tier A (RF), DNF, note.
const heroId = idByTitle.get("Schlossberg Clock Tower");
if (heroId) {
  const ts = now();
  await j("POST", `/api/caches/${heroId}/logs`, {
    loggerCall: "DL1ABC", logType: "found", comment: "Beautiful spot, TFTC!",
    appGeo: { lat: 47.07355, lon: 15.43785, accuracyM: 11, ts },
  });
  // Tier A needs an RF-heard, independently-gated position in the window first.
  await j("POST", "/ingest", {
    packets: [{
      src: "OE3RF", path: ["WIDE1-1", "qAR", "OE8XXX"], payload: "=4704.41N/01526.27E>",
      kind: "position", parsed: { lat: 47.0734, lon: 15.4377, symbol: ">" },
      heardVia: "rf", igateCall: "OE8XXX", port: "aprs-is", ts,
    }],
  }, { "x-ingest-secret": SECRET });
  await j("POST", `/api/caches/${heroId}/logs`, { loggerCall: "OE3RF", logType: "found", comment: "Logged over RF from the tower — 73!" });
  await j("POST", `/api/caches/${heroId}/logs`, { loggerCall: "OE5XYZ", logType: "dnf", comment: "Too many muggles around at noon." });
  await j("POST", `/api/caches/${heroId}/logs`, { loggerCall: "DJ1NOTE", logType: "note", comment: "Clock restored last week — looks great." });
  console.log("seeded logbook on hero cache id", heroId);
}
console.log("seed complete");
