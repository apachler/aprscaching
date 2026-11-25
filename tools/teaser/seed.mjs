// SPDX-License-Identifier: AGPL-3.0-or-later
// Seed a realistic demo dataset (Graz/Styria) for the teaser crawl.
// Idempotent-ish: skips caches whose title already exists, and signs each player in to the account its
// fixed address holds.
//
// The ingest secret only posts what the stations hear. Every hide and every log goes with the player's own
// session: an email sign-in whose link token a gateway without a mail provider hands back. A hider, and an RF
// finder, is control-verified the way an operator is: its `VERIFY <code>` message is heard on the TNC of the
// site OE8XXX by a receiving box the seed enrolls with its own key and trusts for that site, so the seed
// needs OPERATOR_SECRET. Where a call is the instance's ADMIN_CALLSIGNS call (the dev stack), email opens no
// account for it: the seed opens it with the operator's sign-in link and verifies it with the operator
// secret, the way `pnpm dev:admin` does.
import { boxFetch, enrollTrustedBox } from "../smoke/boxsign.mjs";

const API = process.env.API_BASE ?? "http://127.0.0.1:8787";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
const OPERATOR_SECRET = process.env.OPERATOR_SECRET ?? "";
const now = () => Math.floor(Date.now() / 1000);

/** One JSON request with no secret beside it; `headers` add a session cookie or a secret where one belongs. */
const j = (method, path, body, headers = {}) =>
  fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));
const asOperator = (path, body) => j("POST", path, body, { "x-operator-secret": OPERATOR_SECRET });

/** Spend a sign-in link's token; the session cookie, or "". */
async function spend(token) {
  const vr = await fetch(API + "/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return (/(acs=[^;]+)/.exec(vr.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
}

let rxKey = null;
/** The receiving box that hears the players' VERIFY messages, enrolled on first use. */
async function rxBox() {
  if (!rxKey) {
    const rx = OPERATOR_SECRET
      ? await enrollTrustedBox(API, OPERATOR_SECRET, `seed-rx-${now()}`, ["OE8XXX"])
      : { error: "OPERATOR_SECRET is not set" };
    if (rx.error) throw new Error(`no receiving box to hear a VERIFY: ${rx.error}`);
    rxKey = rx.key;
  }
  return rxKey;
}
const isVerified = async (call) => (await j("GET", `/verify/aprs/status?callsign=${call}`)).data?.verified === true;

/** Hear `call`'s answer to a challenge its session starts, on the TNC at OE8XXX; true once verified. */
async function verifyOnAir(call, cookie) {
  const key = await rxBox();
  const ch = await j("POST", "/verify/aprs/start", { callsign: call }, { cookie });
  if (!ch.ok) return false;
  await boxFetch(API, key, "POST", "/ingest", {
    packets: [
      {
        src: `${call}-7`,
        dst: "APRS",
        path: ["WIDE1-1", "qAR", "OE8XXX"],
        payload: `:${String(ch.data.to).padEnd(9)}:${ch.data.text}`,
        kind: "message",
        heardVia: "rf",
        igateCall: "OE8XXX",
        port: "kiss-tnc",
        ts: now(),
      },
    ],
  });
  return isVerified(call);
}

const players = new Map();
/**
 * The session of `call`, signed in on first use; control-verified as well when `verified`. Throws, naming the
 * step the gateway refused, when the call cannot be signed in or verified.
 */
async function player(call, { verified = false } = {}) {
  let p = players.get(call);
  if (!p) {
    const start = await j("POST", "/auth/email/start", { email: `${call.toLowerCase()}@teaser.local`, callsign: call });
    if (start.ok && start.data?.devToken) p = { cookie: await spend(start.data.devToken), operator: false };
    else if (start.status === 409 && start.data?.reason === "operator_call" && OPERATOR_SECRET) {
      const link = await asOperator("/auth/operator-link", { callsign: call });
      const token = link.ok ? new URL(link.data.link).searchParams.get("token") : null;
      if (!token) throw new Error(`${call}: the operator link was refused (${link.status}) ${link.data.error ?? ""}`);
      p = { cookie: await spend(token), operator: true };
    } else throw new Error(`${call} cannot sign in (${start.status}): ${start.data?.error ?? "no sign-in token"}`);
    if (!p.cookie) throw new Error(`${call}: the sign-in link opened no session`);
    players.set(call, p);
  }
  if (verified && !(await isVerified(call))) {
    const ok = p.operator
      ? (await asOperator("/verify/operator", { callsign: call })).ok
      : await verifyOnAir(call, p.cookie);
    if (!ok) throw new Error(`${call} could not be verified`);
  }
  return p.cookie;
}
/** Send as `call`'s own session. */
const as = async (call, opts) => ({ cookie: await player(call, opts) });

// A cache at a SOTA summit or a POTA park is a traditional one: the heritage types come from the sysop's
// import of the places themselves. A living cache rides a station its hider lists under My stations.
const CACHES = [
  {
    title: "Schlossberg Clock Tower",
    type: "traditional",
    lat: 47.0735,
    lon: 15.4378,
    difficulty: 1.5,
    terrain: 2,
    ownerCall: "OE8APR",
    hint: "behind the clock face",
    description: "The classic Grazer Uhrturm starter cache — beacon your position to verify the find.",
  },
  {
    title: "Mur Riverwalk",
    type: "multi",
    lat: 47.07,
    lon: 15.43,
    difficulty: 2,
    terrain: 1.5,
    ownerCall: "OE8APR",
    hint: "stage 1 at the bridge",
  },
  {
    title: "Plabutsch Park",
    type: "traditional",
    lat: 47.082,
    lon: 15.382,
    difficulty: 2.5,
    terrain: 3,
    ownerCall: "OE1POTA",
  },
  {
    title: "Eggenberg Gardens",
    type: "traditional",
    lat: 47.0735,
    lon: 15.39,
    difficulty: 1.5,
    terrain: 1.5,
    ownerCall: "DL2GRZ",
    hint: "by the peacocks",
  },
  {
    title: "Murinsel Echo",
    type: "audio",
    lat: 47.0725,
    lon: 15.4335,
    difficulty: 2,
    terrain: 2,
    ownerCall: "OE8APR",
    description: "Listen for the audio clue on the island.",
  },
  {
    title: "OE8APR Rover",
    type: "aprs_living",
    lat: 47.062,
    lon: 15.405,
    difficulty: 3,
    terrain: 2.5,
    ownerCall: "OE8APR",
    stationCall: "OE8APR-9",
    description: "A living cache: find the rover while it beacons.",
  },
  {
    title: "Hilmteich Loop",
    type: "multi",
    lat: 47.082,
    lon: 15.464,
    difficulty: 2.5,
    terrain: 2,
    ownerCall: "OE5MUL",
  },
  {
    title: "Schoeckl OE/ST-027",
    type: "traditional",
    lat: 47.198,
    lon: 15.466,
    difficulty: 3.5,
    terrain: 4,
    ownerCall: "OE6SOTA",
    description: "SOTA summit — activate from the top.",
  },
];

const existing = (await j("GET", "/api/caches?bbox=-180,-90,180,90")).data.caches ?? [];
const have = new Set(existing.map((c) => c.title));
const idByTitle = new Map(existing.map((c) => [c.title, c.id]));

for (const c of CACHES) {
  if (have.has(c.title)) {
    console.log("skip (exists):", c.title);
    continue;
  }
  const { ownerCall, ...cache } = c;
  const owner = await as(ownerCall, { verified: true });
  if (cache.stationCall)
    await j("POST", "/api/my/stations", { callsign: cache.stationCall, lat: cache.lat, lon: cache.lon }, owner);
  const r = await j("POST", "/api/caches", cache, owner);
  if (r.ok) {
    idByTitle.set(c.title, r.data.cache.id);
    console.log("created:", r.data.cache.code, c.title);
  } else console.error("FAILED:", c.title, r.status, r.data);
}

// Rich logbook on the hero cache: Tier B (app geo), Tier A (RF), DNF, note.
const heroId = idByTitle.get("Schlossberg Clock Tower");
if (heroId) {
  const ts = now();
  const log = async (call, body, opts) => j("POST", `/api/caches/${heroId}/logs`, body, await as(call, opts));
  await log("DL1ABC", {
    logType: "found",
    comment: "Beautiful spot, TFTC!",
    appGeo: { lat: 47.07355, lon: 15.43785, accuracyM: 11, ts },
  });
  // Tier A needs a control-verified finder and a position in the window heard directly by the attested
  // site's own TNC.
  await player("OE3RF", { verified: true });
  await j(
    "POST",
    "/ingest",
    {
      packets: [
        {
          src: "OE3RF",
          path: ["WIDE1-1"],
          payload: "=4704.41N/01526.27E>",
          kind: "position",
          parsed: { lat: 47.0734, lon: 15.4377, symbol: ">" },
          heardVia: "rf",
          igateCall: "OE8XXX",
          port: "kiss-tnc",
          ts,
        },
      ],
    },
    { "x-ingest-secret": SECRET },
  );
  await log("OE3RF", { logType: "found", comment: "Logged over RF from the tower — 73!" });
  await log("OE5XYZ", { logType: "dnf", comment: "Too many muggles around at noon." });
  await log("DJ1NOTE", { logType: "note", comment: "Clock restored last week — looks great." });
  console.log("seeded logbook on hero cache id", heroId);
}

// ---- Demo data: populate the data-driven surfaces (Live stations, station pages, weather graphs,
// track history, activity feed, ranks). The gateway DECODES the APRS `payload`, so seed real payloads. ----
const T = now();
const ingest = (packets) => j("POST", "/ingest", { packets }, { "x-ingest-secret": SECRET });
// build an uncompressed APRS position payload: =DDMM.mmN<symtable>DDDMM.mmE<symcode><comment>
const pad = (n, w) => String(n).padStart(w, "0");
const dm = (v, degW) => {
  const a = Math.abs(v),
    d = Math.floor(a),
    min = (a - d) * 60;
  return pad(d, degW) + pad(min.toFixed(2), 5);
};
const aprsPos = (lat, lon, st, sc, comment = "") =>
  `=${dm(lat, 2)}${lat >= 0 ? "N" : "S"}${st}${dm(lon, 3)}${lon >= 0 ? "E" : "W"}${sc}${comment}`;
const pkt = (src, payload, ts) => ({
  src,
  dst: "APRS",
  path: ["WIDE1-1", "qAR", "OE8XXX"],
  payload,
  kind: "position",
  heardVia: "rf",
  igateCall: "OE8XXX",
  port: "aprs-is",
  ts,
});

// Live stations across roles (the symbol drives the map glyph + role). → stations + station pages.
const STATIONS = [
  { src: "OE8XXX-10", lat: 47.07, lon: 15.44, st: "I", sc: "&", c: "Graz iGate - RX 24/7 JN77rb" },
  { src: "OE6XRR-3", lat: 47.198, lon: 15.466, st: "/", sc: "#", c: "Schoeckl WIDE2 digipeater @1445m" },
  { src: "OE8APR-1", lat: 47.0735, lon: 15.4378, st: "/", sc: "-", c: "home QTH JN77rb" },
  { src: "DL2GRZ-9", lat: 47.0655, lon: 15.45, st: "/", sc: ">", c: "mobile - enroute A2" },
  { src: "OE5MUL-7", lat: 47.082, lon: 15.464, st: "/", sc: "[", c: "HT portable @ Hilmteich" },
  { src: "OE8WX-13", lat: 47.076, lon: 15.421, st: "/", sc: "_", c: "PWS Graz-West" },
];
for (const s of STATIONS) await ingest([pkt(s.src, aprsPos(s.lat, s.lon, s.st, s.sc, s.c), T)]);
console.log("seeded", STATIONS.length, "live stations");

// A rover track over the last ~2h → track history / replay.
for (let i = 12; i >= 0; i--) {
  const f = (12 - i) / 12;
  await ingest([
    pkt("OE8APR-9", aprsPos(47.045 + f * 0.03, 15.39 + f * 0.04, "/", ">", "living cache rover"), T - i * 600),
  ]);
}
console.log("seeded rover track (13 fixes)");

// Hourly weather (APRS position+weather report) for the PWS → weather graphs (sensor_readings).
const cToF = (c) => Math.round((c * 9) / 5 + 32);
for (let i = 23; i >= 0; i--) {
  const h = 23 - i;
  const tC = 9 + 6 * Math.sin((h / 24) * Math.PI * 2) + (h % 3) * 0.4;
  const wx =
    `=${dm(47.076, 2)}N/${dm(15.421, 3)}E_${pad((120 + h * 8) % 360, 3)}/${pad(4 + (h % 7), 3)}` +
    `g${pad(7 + (h % 5), 3)}t${pad(cToF(tC), 3)}h${pad((60 + ((h * 3) % 30)) % 100, 2)}b${pad((1012 + ((h % 5) - 2)) * 10, 5)}`;
  await ingest([
    {
      src: "OE8WX-13",
      dst: "APRS",
      path: ["qAR", "OE8XXX"],
      payload: wx,
      heardVia: "aprs_is",
      igateCall: "OE8XXX",
      port: "aprs-is",
      ts: T - i * 3600,
    },
  ]);
}
console.log("seeded 24h weather for OE8WX-13");

// APRS text messages → the Messages surface (first-class inbox, separate from BBS). Payload is the
// APRS message format `:ADDRESSEE :text{msgno` (addressee padded to 9). Some are to/from OE8APR
// (highlighted as "yours" in the inbox), some are third-party traffic.
const msg = (src, to, text, ts, id) => ({
  src,
  dst: "APRS",
  path: ["WIDE1-1", "qAR", "OE8XXX"],
  payload: `:${String(to).padEnd(9)}:${text}{${id}`,
  heardVia: "rf",
  igateCall: "OE8XXX",
  port: "aprs-is",
  ts,
});
const MSGS = [
  ["OE3ABC", "OE8APR", "QRV Schoeckl 0900z, see you at the car park 73", 240, "042"],
  ["DL2XYZ", "OE8APR", "TU for the 20m QSO, card via bureau 73", 900, "017"],
  ["OE5FLM", "OE8APR", "Found your living cache on the summit, nice hide!", 1800, "088"],
  ["OE6XRR-3", "OE3ABC", "digi test de Schoeckl, ur 599 here", 1500, "003"],
  ["OE8APR", "OE3ABC", "roger, bringing coffee + spare LiFePO4 73", 600, "051"],
];
for (const [src, to, text, ago, id] of MSGS) await ingest([msg(src, to, text, T - ago, id)]);
console.log("seeded", MSGS.length, "APRS messages");

// More finds across caches → richer Activity feed + Leaderboard. Each finder logs another hider's cache: an
// owner does not find their own.
const finders = [
  ["Mur Riverwalk", "OE3ABC", "found", "Nice two-stage, solved it at the bridge. TFTC!"],
  ["Eggenberg Gardens", "OE5MUL", "found", "Peacocks approved. Quick find."],
  ["Plabutsch Park", "OE6SOTA", "found", "POTA + cache combo, activated 20m too."],
  ["Hilmteich Loop", "DL2GRZ", "found", "Great walk around the pond."],
  ["Murinsel Echo", "OE5FLM", "found", "Decoded the audio clue on the second try!"],
  ["Schoeckl OE/ST-027", "OE1POTA", "found", "Summit activated, 8 QSOs on 2m FM. vy73"],
  ["Mur Riverwalk", "DL1ABC", "found", "Quick one on the way to work — all good."],
  ["Eggenberg Gardens", "OE3ABC", "dnf", "Ran out of daylight, back next week."],
];
let logged = 0;
for (const [title, call, logType, comment] of finders) {
  const id = idByTitle.get(title);
  if (!id) continue;
  const appGeo =
    logType === "found"
      ? {
          lat: CACHES.find((c) => c.title === title).lat + 0.0001,
          lon: CACHES.find((c) => c.title === title).lon,
          accuracyM: 12,
          ts: T,
        }
      : undefined;
  const r = await j("POST", `/api/caches/${id}/logs`, { logType, comment, appGeo }, await as(call));
  if (r.ok) logged++;
  else console.error("log FAILED:", call, logType, title, r.status, r.data);
}
console.log("seeded", logged, "extra cache logs");

// OE8APR hid caches above, so its call is verified: the teaser chrome shows an ACTIVATED operator (the green
// check, not "unverified"), and the tour signs in to this same account (oe8apr@teaser.local).
console.log("verified operator OE8APR:", await isVerified("OE8APR"));
console.log("seed complete");
