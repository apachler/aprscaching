// SPDX-License-Identifier: AGPL-3.0-or-later
// Runtime-agnostic conformance smoke test for the aprscaching gateway.
// Runs the same end-to-end flow against ANY base URL (Node/SQLite or Bun/bun:sqlite),
// so CI can prove the two runtimes behave identically. Exits non-zero on the first failure.
//
//   BASE=http://127.0.0.1:8787 node tools/smoke/smoke.mjs

import { cborDecode as miniDecode, frameParts, signingBytes, decodePage } from "./fedwire-mini.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
// Operator-level endpoints (callsign bootstrap, forwarding rules, donations) take OPERATOR_SECRET — the
// ingest secret never reaches them.
const OPERATOR_SECRET = process.env.OPERATOR_SECRET ?? "";
const now = () => Math.floor(Date.now() / 1000);
let failures = 0;

/** True when `u` is an absolute URL on github.com itself (a host match, not a substring match). */
function isGithubUrl(u) {
  try {
    return new URL(String(u)).hostname === "github.com";
  } catch {
    return false;
  }
}

function ok(name, cond, detail = "") {
  const pass = !!cond;
  console.log(`${pass ? "✓" : "✗"} ${name}${pass ? "" : `  — ${detail}`}`);
  if (!pass) failures++;
}

async function call(method, path, body, headers = {}) {
  // The smoke acts as the ingest box (it holds INGEST_SECRET), so writes that attribute an arbitrary
  // RF/heard callsign go through the ingest-authorised path, and as the operator's scripts (it holds
  // OPERATOR_SECRET). Explicit headers still win (e.g. the bad-secret rejection tests). Web session
  // gating is checked separately below.
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-ingest-secret": SECRET,
      ...(OPERATOR_SECRET ? { "x-operator-secret": OPERATOR_SECRET } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, data };
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

console.log(`smoke: ${BASE}`);
ok("health", await waitHealthy());

// ---- auth: email magic-link register -> session (the headless-exercisable path) ----
{
  const email = `smoke+${now()}@example.test`;
  const callsign = `OE${now() % 1000}X`;
  const start = await call("POST", "/auth/email/start", { email, callsign });
  ok(
    "auth: email/start -> devToken (dev mode)",
    start.status === 200 && !!start.data?.devToken,
    `status=${start.status} ${JSON.stringify(start.data)}`,
  );
  const vr = await fetch(BASE + "/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: start.data?.devToken }),
  });
  const vd = await vr.json().catch(() => ({}));
  const cookie = (/(acs=[^;]+)/.exec(vr.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
  ok(
    "auth: email/verify -> session cookie + callsign",
    vr.status === 200 && vd.callsign === callsign && cookie.startsWith("acs="),
    `status=${vr.status} cookie=${cookie} ${JSON.stringify(vd)}`,
  );
  const sess = await call("GET", "/auth/session", undefined, { cookie });
  ok("auth: session -> signed-in callsign", sess.data?.callsign === callsign, JSON.stringify(sess.data));
}

// hide a cache
const created = await call("POST", "/api/caches", {
  title: "Smoke Cache",
  type: "traditional",
  lat: 47.0735,
  lon: 15.4378,
  difficulty: 1.5,
  terrain: 2,
  ownerCall: "OE8APR",
  hint: "behind the clock",
});
ok(
  "create -> 201 + AC code",
  created.status === 201 && /^AC-\d+/.test(created.data?.cache?.code ?? ""),
  `status=${created.status} ${JSON.stringify(created.data)}`,
);
const id = created.data?.cache?.id;
// A request with neither a session nor the ingest secret: what a stranger's browser sends.
const ANON = { "x-ingest-secret": "" };
const mintedCode = await call("POST", "/api/caches", {
  title: "Minted squat",
  type: "traditional",
  lat: 47,
  lon: 15,
  difficulty: 1,
  terrain: 1,
  ownerCall: "OE8APR",
  code: "AC-9999",
});
ok("an explicit AC- code is refused, even for the instance", mintedCode.status === 400, `status=${mintedCode.status}`);

// the virtual cache type (location/riddle/landmark, no container) is accepted end-to-end
const vCache = await call("POST", "/api/caches", {
  title: "Virtual Landmark",
  type: "virtual",
  lat: 47.08,
  lon: 15.44,
  ownerCall: "OE8APR",
});
ok(
  "create accepts the virtual cache type",
  vCache.status === 201 && vCache.data?.cache?.type === "virtual",
  `status=${vCache.status} ${JSON.stringify(vCache.data?.cache)}`,
);

// drive-in flag + country + tags (deduped/lowercased), round-tripped through create + detail
const metaCache = await call("POST", "/api/caches", {
  title: "Drive-In Lookout",
  type: "traditional",
  lat: 47.09,
  lon: 15.45,
  ownerCall: "OE8APR",
  driveIn: true,
  country: "OE",
  tags: ["Scenic", "scenic", "QRP"],
});
ok(
  "create stores drive-in + country + deduped tags",
  metaCache.status === 201 &&
    metaCache.data?.cache?.driveIn === true &&
    metaCache.data?.cache?.country === "OE" &&
    Array.isArray(metaCache.data?.cache?.tags) &&
    metaCache.data.cache.tags.join(",") === "scenic,qrp",
  JSON.stringify(metaCache.data?.cache),
);
const metaDetail = await call("GET", `/api/caches/${metaCache.data?.cache?.id}`);
ok(
  "cache detail carries drive-in + tags",
  metaDetail.data?.cache?.driveIn === true && (metaDetail.data?.cache?.tags ?? []).includes("scenic"),
  JSON.stringify(metaDetail.data?.cache?.tags),
);

// list in bbox
const list = await call("GET", "/api/caches?bbox=15,46,16,48");
ok(
  "list includes the new cache",
  (list.data?.caches ?? []).some((c) => c.id === id),
);

// Tier B — in-app geolocation near the cache, from the player's own session (the ingest plane has no in-app
// reading, so a geolocation it sends counts for nothing)
const dl1abcCookie = await signUp("DL1ABC");
const tb = await call(
  "POST",
  `/api/caches/${id}/logs`,
  { loggerCall: "DL1ABC", logType: "found", appGeo: { lat: 47.07355, lon: 15.43785, accuracyM: 11, ts: now() } },
  { cookie: dl1abcCookie },
);
ok("Tier B verified (app_geo)", tb.data?.verified === true && tb.data?.tier === "B", JSON.stringify(tb.data));

// offline pack: the area's caches with their latest logs (a window query every runtime must run), and a
// cheap 304 for an unchanged area
const packRes = await fetch(`${BASE}/api/offline/pack?grid=JN77`);
const packBody = await packRes.json().catch(() => null);
const packed = (packBody?.caches ?? []).find((c) => c.id === id);
ok(
  "offline pack holds the cache with its log",
  packRes.status === 200 && packed?.logs?.length > 0,
  JSON.stringify(packed?.logs?.length),
);
const packAgain = await fetch(`${BASE}/api/offline/pack?grid=JN77`, {
  headers: { "if-none-match": packRes.headers.get("etag") ?? "" },
});
ok("offline pack answers 304 when unchanged", packAgain.status === 304, String(packAgain.status));

// Tier A is never granted from APRS-IS: a `qAR,OE8XXX` line naming the attested site is something anyone
// with a (public) passcode can inject, so the find it backs stays below Tier A
const isQar = await call(
  "POST",
  "/ingest",
  {
    packets: [
      {
        src: "OE3IS",
        path: ["WIDE1-1", "qAR", "OE8XXX"],
        payload: "=4704.80N/01526.40E>",
        kind: "position",
        parsed: { lat: 47.08, lon: 15.44, symbol: ">" },
        heardVia: "rf",
        igateCall: "OE8XXX",
        port: "aprs-is",
        ts: now(),
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);
const isQarLog = await call("POST", `/api/caches/${vCache.data?.cache?.id}/logs`, {
  loggerCall: "OE3IS",
  logType: "found",
});
ok(
  "an APRS-IS qAR line naming the attested site does not reach Tier A",
  isQar.data?.stored === 1 && isQarLog.data?.logged === true && isQarLog.data?.tier !== "A",
  JSON.stringify(isQarLog.data),
);

// Tier A — heard directly by the attested site's own TNC (the ingest stamps the site call), then a found log
const ing = await call(
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
        ts: now(),
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);
ok("ingest stores 1 position", ing.data?.ok === true && ing.data?.stored === 1, JSON.stringify(ing.data));
const ta = await call("POST", `/api/caches/${id}/logs`, { loggerCall: "OE3RF", logType: "found" });
ok("Tier A verified (aprs_rf)", ta.data?.verified === true && ta.data?.tier === "A", JSON.stringify(ta.data));

// owner-gated rating — default policy 'finders' lets a verified finder rate, blocks a non-finder
const rateFinder = await call("POST", `/api/caches/${id}/rate`, { callsign: "DL1ABC", stars: 4 });
ok(
  "a verified finder can rate (1–5)",
  rateFinder.status === 200 && rateFinder.data?.rating?.mine === 4 && rateFinder.data?.rating?.count >= 1,
  JSON.stringify(rateFinder.data),
);
const rateNon = await call("POST", `/api/caches/${id}/rate`, { callsign: "NOFIND", stars: 5 });
ok("a non-finder is blocked under the 'finders' policy (403)", rateNon.status === 403, JSON.stringify(rateNon.data));
const ratedDetail = await call("GET", `/api/caches/${id}`);
ok(
  "cache detail carries the rating aggregate",
  (ratedDetail.data?.cache?.rating?.count ?? 0) >= 1 && ratedDetail.data?.cache?.rating?.avg >= 1,
  JSON.stringify(ratedDetail.data?.cache?.rating),
);

// DNF — recorded, never verified
const dnf = await call("POST", `/api/caches/${id}/logs`, { loggerCall: "OE5XYZ", logType: "dnf" });
ok("DNF logged, unverified", dnf.data?.logged === true && dnf.data?.verified === false, JSON.stringify(dnf.data));

// --- web logging/hiding is gated behind a session (the over-APRS path stays open via secret) ---
const anonLogRes = await fetch(`${BASE}/api/caches/${id}/logs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ loggerCall: "NOSESS", logType: "found" }),
});
ok("web log without a session is rejected (401)", anonLogRes.status === 401, `status=${anonLogRes.status}`);
const anonHideRes = await fetch(`${BASE}/api/caches`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "x", type: "traditional", lat: 47, lon: 15, ownerCall: "NOSESS" }),
});
ok("web hide without a session is rejected (401)", anonHideRes.status === 401, `status=${anonHideRes.status}`);
// the genuine web path: register via email magic-link -> session cookie -> log attributed to it
// (on its own cache, so the find count of the shared `id` cache is left untouched)
const SESSCALL = "OE9SESS";
const eStart = await call("POST", "/auth/email/start", { email: `s${now()}@example.com`, callsign: SESSCALL });
// opening the link only shows a confirm step — the token is spent by the POST that follows
const eLink = await fetch(`${BASE}/auth/email/verify?token=${eStart.data.devToken}`, {
  headers: { accept: "text/html" },
});
ok(
  "email link GET shows a confirm step and signs nobody in",
  eLink.status === 200 && !eLink.headers.get("set-cookie") && (await eLink.text()).includes('method="post"'),
  String(eLink.status),
);
const eVer = await fetch(`${BASE}/auth/email/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: eStart.data.devToken }),
});
const cookie = (eVer.headers.get("set-cookie") ?? "").split(";")[0];
const sCache = await call("POST", "/api/caches", {
  title: "Session Find " + now(),
  type: "traditional",
  lat: 47.2,
  lon: 15.6,
  ownerCall: "OE8APR",
});
const sCacheId = sCache.data?.cache?.id;
const sessLog = await fetch(`${BASE}/api/caches/${sCacheId}/logs`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ logType: "found" }), // no loggerCall: the session attributes it
});
const sessLogBody = await sessLog.json().catch(() => ({}));
ok(
  "session (email) log succeeds",
  sessLog.status === 200 && sessLogBody.logged === true,
  `status=${sessLog.status} ${JSON.stringify(sessLogBody)}`,
);
const sessDetail = await call("GET", `/api/caches/${sCacheId}`);
ok(
  "the session find is attributed to the signed-in callsign",
  (sessDetail.data?.cache?.logs ?? []).some((l) => l.loggerCall === SESSCALL),
  JSON.stringify((sessDetail.data?.cache?.logs ?? []).map((l) => l.loggerCall)),
);
const playerCode = await call(
  "POST",
  "/api/caches",
  { title: "Squat", type: "traditional", lat: 47, lon: 15, difficulty: 1, terrain: 1, code: "GC-SQUAT" },
  { ...ANON, cookie },
);
ok("a player cannot choose a cache code -> 403", playerCode.status === 403, `status=${playerCode.status}`);
const sessFav = await call(
  "POST",
  `/api/caches/${sCacheId}/favorite`,
  { callsign: "DL1ABC", on: true },
  { ...ANON, cookie },
);
const favOf = async (cs) => (await call("GET", `/api/caches/${sCacheId}?callsign=${cs}`)).data?.cache?.favorited;
ok(
  "a favourite is the signed-in caller's, whatever the body names",
  sessFav.status === 200 && (await favOf(SESSCALL)) === true && (await favOf("DL1ABC")) === false,
  `status=${sessFav.status}`,
);

// change the active callsign — re-binds the session and resets verification to pending
const chg = await fetch(`${BASE}/auth/callsign`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ callsign: "OE9CHG" }),
});
const chgBody = await chg.json().catch(() => ({}));
const cookie2 = (chg.headers.get("set-cookie") ?? "").split(";")[0] || cookie;
ok(
  "change callsign succeeds + re-binds the session",
  chg.status === 200 && chgBody.callsign === "OE9CHG",
  `status=${chg.status} ${JSON.stringify(chgBody)}`,
);
const who = await fetch(`${BASE}/auth/session`, { headers: { cookie: cookie2 } });
const whoBody = await who.json().catch(() => ({}));
ok(
  "session reports the new callsign, unverified",
  whoBody.callsign === "OE9CHG" && whoBody.verified === false,
  JSON.stringify(whoBody),
);
const chgSame = await fetch(`${BASE}/auth/callsign`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookie2 },
  body: JSON.stringify({ callsign: "OE9CHG" }),
});
ok("changing to your current callsign -> 400", chgSame.status === 400, `status=${chgSame.status}`);

// --- multiple verified base calls per account (account_callsigns) ---
// the account now holds OE9SESS (primary, from email register) + OE9CHG (switched-to). Verify the
// active call, switch away to the primary, switch BACK, and confirm verification is preserved —
// switching among held calls must never re-challenge.
const mcList1 = await (await fetch(`${BASE}/auth/callsigns`, { headers: { cookie: cookie2 } })).json();
const mcCalls1 = mcList1.callsigns ?? [];
ok(
  "account holds its primary + the switched-to call",
  mcCalls1.some((c) => c.callsign === "OE9SESS" && c.isPrimary) &&
    mcCalls1.some((c) => c.callsign === "OE9CHG" && c.active),
  JSON.stringify(mcList1),
);
ok("active callsign verifies by an on-air VERIFY", await verifyCallsign("OE9CHG", cookie2));
const whoV = await (await fetch(`${BASE}/auth/session`, { headers: { cookie: cookie2 } })).json();
ok(
  "session reports the active callsign as verified",
  whoV.callsign === "OE9CHG" && whoV.verified === true,
  JSON.stringify(whoV),
);
const toPrimary = await fetch(`${BASE}/auth/callsign`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookie2 },
  body: JSON.stringify({ callsign: "OE9SESS" }),
});
const cookieP = (toPrimary.headers.get("set-cookie") ?? "").split(";")[0] || cookie2;
const whoP = await (await fetch(`${BASE}/auth/session`, { headers: { cookie: cookieP } })).json();
ok(
  "switching to the unverified primary reports it unverified (per-call state)",
  whoP.callsign === "OE9SESS" && whoP.verified === false,
  JSON.stringify(whoP),
);
const back = await fetch(`${BASE}/auth/callsign`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookieP },
  body: JSON.stringify({ callsign: "OE9CHG" }),
});
const backBody = await back.json().catch(() => ({}));
const cookieB = (back.headers.get("set-cookie") ?? "").split(";")[0] || cookieP;
ok(
  "switching back to a held verified call preserves verification (no re-challenge)",
  backBody.verified === true,
  JSON.stringify(backBody),
);
const whoB = await (await fetch(`${BASE}/auth/session`, { headers: { cookie: cookieB } })).json();
ok(
  "session confirms the restored verification",
  whoB.callsign === "OE9CHG" && whoB.verified === true,
  JSON.stringify(whoB),
);
// add a brand-new base call (held + unverified; SSID is stripped; active call unchanged)
const add = await fetch(`${BASE}/auth/callsigns`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookieB },
  body: JSON.stringify({ callsign: "OE9ADD-7" }),
});
const addBody = await add.json().catch(() => ({}));
ok(
  "adding a base call holds it unverified without switching",
  add.status === 200 && addBody.callsign === "OE9ADD" && addBody.verified === false,
  `status=${add.status} ${JSON.stringify(addBody)}`,
);
const mcList2 = await (await fetch(`${BASE}/auth/callsigns`, { headers: { cookie: cookieB } })).json();
ok(
  "the added call joins the held set; active is unchanged",
  (mcList2.callsigns ?? []).some((c) => c.callsign === "OE9ADD") && mcList2.active === "OE9CHG",
  JSON.stringify(mcList2),
);
const addDup = await fetch(`${BASE}/auth/callsigns`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookieB },
  body: JSON.stringify({ callsign: "OE9ADD" }),
});
ok("adding a call you already hold -> 409", addDup.status === 409, `status=${addDup.status}`);
// a base call held by ANOTHER account is off-limits (both add and switch are rejected)
const otherStart = await call("POST", "/auth/email/start", { email: `o${now()}@example.com`, callsign: "OE2OTHER" });
await fetch(`${BASE}/auth/email/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: otherStart.data.devToken }),
});
const addOther = await fetch(`${BASE}/auth/callsigns`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookieB },
  body: JSON.stringify({ callsign: "OE2OTHER" }),
});
ok("adding a call held by another account -> 409", addOther.status === 409, `status=${addOther.status}`);
const switchOther = await fetch(`${BASE}/auth/callsign`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookieB },
  body: JSON.stringify({ callsign: "OE2OTHER" }),
});
ok("switching to a call held by another account -> 409", switchOther.status === 409, `status=${switchOther.status}`);

// owner gating + auth guards
const wrongOwner = await call("PATCH", `/api/caches/${id}`, { ownerCall: "DL9NO", difficulty: 5 });
ok("non-owner edit -> 403", wrongOwner.status === 403, `status=${wrongOwner.status}`);
const badSecret = await call("POST", "/ingest", { packets: [] }, { "x-ingest-secret": "wrong" });
ok("bad ingest secret -> 401", badSecret.status === 401, `status=${badSecret.status}`);
const missing = await call("GET", "/api/caches/999999");
ok("unknown cache -> 404", missing.status === 404, `status=${missing.status}`);

// AGPL §13 source link — every instance exposes its running source
const srcDesc = await call("GET", "/.well-known/source");
ok(
  "AGPL §13 source descriptor (repo + AGPL licence)",
  isGithubUrl(srcDesc.data?.repo) && srcDesc.data?.license === "AGPL-3.0-or-later",
  JSON.stringify(srcDesc.data),
);
const srcRedir = await fetch(`${BASE}/source`, { redirect: "manual" });
ok(
  "/source 302-redirects to the repo",
  srcRedir.status === 302 && isGithubUrl(srcRedir.headers.get("location")),
  `status=${srcRedir.status} loc=${srcRedir.headers.get("location")}`,
);

// detail: 2 verified finds + a 4-entry-less logbook (3 logs here)
const detail = await call("GET", `/api/caches/${id}`);
ok("detail: 2 verified finds", detail.data?.cache?.finds === 2, JSON.stringify(detail.data?.cache?.finds));
ok(
  "detail: logbook has 3 entries",
  (detail.data?.cache?.logs ?? []).length === 3,
  `len=${(detail.data?.cache?.logs ?? []).length}`,
);
ok(
  "detail: carries a finds-over-time series",
  Array.isArray(detail.data?.cache?.findsByMonth) && detail.data.cache.findsByMonth.some((m) => m.n > 0),
  JSON.stringify(detail.data?.cache?.findsByMonth),
);

// keyset pagination: page the logbook 2 at a time and follow the cursor with no overlap
const lp1 = await call("GET", `/api/caches/${id}/logs?limit=2`);
ok(
  "logbook page 1 returns 2 + a nextCursor",
  (lp1.data?.logs ?? []).length === 2 && lp1.data?.hasMore === true && !!lp1.data?.nextCursor,
  JSON.stringify({ n: lp1.data?.logs?.length, more: lp1.data?.hasMore }),
);
const lp2 = await call("GET", `/api/caches/${id}/logs?limit=2&cursor=${encodeURIComponent(lp1.data.nextCursor)}`);
const ids1 = new Set((lp1.data?.logs ?? []).map((l) => l.id));
ok(
  "logbook page 2 continues with no overlap",
  (lp2.data?.logs ?? []).length === 1 &&
    lp2.data?.hasMore === false &&
    !(lp2.data?.logs ?? []).some((l) => ids1.has(l.id)),
  JSON.stringify({ n: lp2.data?.logs?.length, more: lp2.data?.hasMore }),
);

// ---- federation: discovery + signed, mirrorable feeds ----
const wk = await call("GET", "/.well-known/aprscaching");
ok("well-known descriptor", (wk.data?.protocol ?? "").startsWith("aprscaching-federation"), JSON.stringify(wk.data));
const fc = await call("GET", "/federation/caches?since=0&limit=500");
ok(
  "caches feed has records",
  Array.isArray(fc.data?.items) && fc.data.items.some((r) => typeof r.id === "string" && r.id.includes(":cache:")),
  `count=${fc.data?.count}`,
);
const ff = await call("GET", "/federation/finds?since=0&limit=500");
ok("finds feed has >= 2 records", (ff.data?.items?.length ?? 0) >= 2, `count=${ff.data?.count}`);
const ff2 = await call("GET", `/federation/finds?since=${ff.data?.nextCursor ?? 0}`);
ok("finds cursor advances (empty past nextCursor)", (ff2.data?.items?.length ?? 0) === 0);

if (wk.data?.signed) {
  // signatures live on the CBOR sync surface: pull a fedwire frame and verify its domain-separated
  // Ed25519 signature against the instance's published key (the JSON feed above is unsigned browse)
  const syncRes = await fetch(`${BASE}/federation/sync/cache?since=0&limit=10`);
  const page = syncRes.ok ? decodePage(new Uint8Array(await syncRes.arrayBuffer())) : { frames: [] };
  const frame0 = page.frames[0];
  let frameOk = false;
  if (frame0) {
    const parts = frameParts(frame0);
    const key = await crypto.subtle.importKey("jwk", wk.data.publicKeyJwk, { name: "Ed25519" }, false, ["verify"]);
    const sigOk = await crypto.subtle.verify("Ed25519", key, parts.sig, signingBytes(parts.payload));
    const gid = miniDecode(parts.payload).get(2);
    frameOk = sigOk && typeof gid === "string" && gid.includes(":cache:");
  }
  ok("signed cache frame on the sync surface verifies against published key", frameOk);
} else {
  console.log("• federation unsigned (no FED_PRIVATE_KEY) — signature check skipped");
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
}

// ---- per-callsign signing (single instance, exercised on both runtimes) ----
const b64u = (buf) => {
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubRaw = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
// a device key binds only through the holder's own session — the ingest secret registers nothing
const regByIngest = await call("POST", "/keys/register", { callsign: "DL1ABC", publicKey: pubRaw });
ok(
  "key registration with the ingest secret alone is refused (401)",
  regByIngest.status === 401,
  String(regByIngest.status),
);
const reg = await call("POST", "/keys/register", { callsign: "DL1ABC", publicKey: pubRaw }, { cookie: dl1abcCookie });
ok("key registration accepted", reg.data?.ok === true, JSON.stringify(reg.data));

// A found is idempotent per (cache, logger). DL1ABC already found `id` above, so the
// signed-find + tamper checks below run against their OWN fresh cache (a duplicate would short-circuit
// before echoing signerKey; a tampered *replay* is still rejected by the signature check, tested here).
const sfCache = await call("POST", "/api/caches", {
  title: "Signed Find Cache",
  type: "traditional",
  lat: 47.074,
  lon: 15.438,
  difficulty: 1,
  terrain: 1,
  ownerCall: "OE8APR",
});
const sfId = sfCache.data?.cache?.id;
const at = now();
const amsg = stableStringify({
  v: 1,
  cache: sfCache.data?.cache?.code,
  instance: wk.data?.instance,
  logger: "DL1ABC",
  logType: "found",
  at,
});
const sig = b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(amsg)));
const signed = await call("POST", `/api/caches/${sfId}/logs`, {
  loggerCall: "DL1ABC",
  logType: "found",
  author: { authorKey: pubRaw, authorSig: sig, signedAt: at },
});
ok(
  "signed find accepted; signerKey echoed",
  signed.data?.logged === true && signed.data?.signerKey === pubRaw,
  JSON.stringify(signed.data),
);

// signed browser RF ingest: push to a public gateway with the device key, no secret
const sha256hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const rfPkts = [
  {
    src: "OE5SIG",
    dst: "APRS",
    path: ["WIDE1-1"],
    payload: "!4704.41N/01526.27E>RF",
    kind: "position",
    heardVia: "rf",
    port: "webserial-kiss",
    ts: now(),
  },
];
const iat = now();
const idigest = await sha256hex(stableStringify(rfPkts));
const imsg = stableStringify({
  v: 1,
  kind: "ingest",
  callsign: "DL1ABC",
  at: iat,
  count: rfPkts.length,
  digest: idigest,
});
// domain-prefixed (acs-ing/1): the gateway verifies only the prefixed form
const isig = b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode("acs-ing/1\n" + imsg)));
const sIng = await fetch(`${BASE}/ingest`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-acs-callsign": "DL1ABC",
    "x-acs-key": pubRaw,
    "x-acs-sig": isig,
    "x-acs-at": String(iat),
  },
  body: JSON.stringify({ packets: rfPkts }),
});
ok("signed browser ingest accepted without the shared secret", sIng.status === 200, String(sIng.status));
const unsignedIngestRes = await fetch(`${BASE}/ingest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ packets: rfPkts }),
});
ok(
  "ingest with neither secret nor signature is rejected (401)",
  unsignedIngestRes.status === 401,
  String(unsignedIngestRes.status),
);
// flip the first (fully-significant) base64url char so the signature is guaranteed to differ
const badSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
const tampered = await call("POST", `/api/caches/${sfId}/logs`, {
  loggerCall: "DL1ABC",
  logType: "found",
  author: { authorKey: pubRaw, authorSig: badSig, signedAt: at },
});
ok("tampered author signature -> 400", tampered.status === 400, `status=${tampered.status}`);

// ---- community / gamification ----
// leaderboard credit requires a control-verified callsign — an unverified logger is excluded
const lbPre = await call("GET", "/api/leaderboard?metric=finds");
ok(
  "unverified callsign earns no leaderboard credit",
  !(lbPre.data?.leaderboard ?? []).some((e) => e.loggerCall === "DL1ABC"),
  JSON.stringify(lbPre.data),
);
// Control-verify a call the real way: the holder's session starts a challenge (nothing is sent), and the
// holder's `VERIFY <code>` message counts only as heard on the TNC of the attested site OE8XXX.
async function signUp(cs) {
  const st = await call("POST", "/auth/email/start", {
    email: `${cs.toLowerCase()}+${now()}@example.test`,
    callsign: cs,
  });
  const vr = await fetch(BASE + "/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: st.data?.devToken }),
  });
  return (/(acs=[^;]+)/.exec(vr.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
}
function verifyMessage(cs, start, onAir) {
  const stamp = onAir
    ? { path: ["WIDE1-1", "qAR", "OE8XXX"], heardVia: "rf", igateCall: "OE8XXX", port: "kiss-tnc" }
    : { path: ["TCPIP*", "qAR", "OE8XXX"], heardVia: "aprs_is", igateCall: "OE8XXX", port: "aprs-is" };
  const packet = {
    src: `${cs}-7`,
    dst: "APRS",
    payload: `:${String(start.to).padEnd(9)}:${start.text}`,
    kind: "message",
    ts: now(),
    ...stamp,
  };
  return call("POST", "/ingest", { packets: [packet] }, { "x-ingest-secret": SECRET });
}
async function isVerified(cs) {
  return (await call("GET", `/verify/aprs/status?callsign=${cs}`)).data?.verified === true;
}
async function verifyCallsign(cs, cookie) {
  const start = await call("POST", "/verify/aprs/start", { callsign: cs }, { cookie });
  if (start.status !== 200) return false;
  await verifyMessage(cs, start.data, true);
  return isVerified(cs);
}
{
  const cookie = dl1abcCookie;
  const outboxBefore = (await call("GET", "/outbox")).data?.items?.length ?? 0;
  const start = await call("POST", "/verify/aprs/start", { callsign: "DL1ABC" }, { cookie });
  ok(
    "verify start names the service call and the exact text to transmit",
    start.status === 200 && start.data?.to === "APRSCG" && start.data?.text === `VERIFY ${start.data?.code}`,
    JSON.stringify(start.data),
  );
  ok(
    "verify start transmits nothing (the outbox is unchanged)",
    ((await call("GET", "/outbox")).data?.items?.length ?? 0) === outboxBefore,
  );
  await verifyMessage("DL1ABC", start.data, false);
  ok("a VERIFY message over APRS-IS does not verify the callsign", !(await isVerified("DL1ABC")));
  await verifyMessage("DL1ABC", start.data, true);
  ok("a VERIFY message heard on the TNC at the attested site verifies the callsign", await isVerified("DL1ABC"));
}
{
  // MeshCom: a direct message to the service call counts only when the attested node (OE8XXX) heard it
  // directly over LoRa; a copy relayed across the mesh names no gate and does not verify.
  const cookie = await signUp("OE9MSH");
  const start = await call("POST", "/verify/aprs/start", { callsign: "OE9MSH" }, { cookie });
  const mesh = (extra) =>
    call(
      "POST",
      "/ingest",
      {
        packets: [
          {
            src: "OE9MSH-1",
            dst: "APRS",
            path: [],
            payload: `:${String(start.data?.to).padEnd(9)}:${start.data?.text}{012`,
            kind: "message",
            heardVia: "rf",
            port: "meshcom",
            rxCall: "OE8XXX",
            ts: now(),
            ...extra,
          },
        ],
      },
      { "x-ingest-secret": SECRET },
    );
  await mesh({ path: ["OE1XYZ-12"] });
  ok("a MeshCom VERIFY relayed across the mesh does not verify the callsign", !(await isVerified("OE9MSH")));
  await mesh({ igateCall: "OE8XXX" });
  ok("a MeshCom VERIFY heard directly by the attested node verifies the callsign", await isVerified("OE9MSH"));
}
ok(
  "the operator bootstrap refuses a missing operator secret",
  (await call("POST", "/verify/operator", { callsign: "DL1ABC" }, { "x-operator-secret": "" })).status === 401,
);
ok(
  "the operator bootstrap refuses the ingest secret",
  (
    await call(
      "POST",
      "/verify/operator",
      { callsign: "DL1ABC" },
      { "x-operator-secret": "", "x-ingest-secret": SECRET },
    )
  ).status === 401,
);
const lb = await call("GET", "/api/leaderboard?metric=finds");
ok(
  "a verified callsign now ranks on the leaderboard",
  (lb.data?.leaderboard ?? []).some((e) => e.loggerCall === "DL1ABC" && e.finds >= 1),
  JSON.stringify(lb.data),
);
const prof = await call("GET", "/api/profile/DL1ABC");
ok(
  "profile shows verified finds + points",
  (prof.data?.finds ?? 0) >= 1 && (prof.data?.points ?? 0) > 0,
  JSON.stringify(prof.data),
);
ok(
  "profile awards a find badge",
  (prof.data?.badges ?? []).some((b) => b.badge === "first-find"),
  JSON.stringify(prof.data?.badges),
);
const favOn = await call("POST", `/api/caches/${id}/favorite`, { callsign: "DL1ABC", on: true });
ok("favorite toggled on", favOn.data?.on === true && (favOn.data?.count ?? 0) >= 1, JSON.stringify(favOn.data));
const favAnon = await call("POST", `/api/caches/${id}/favorite`, { callsign: "DL1ABC", on: false }, ANON);
const watchAnon = await call("POST", `/api/caches/${id}/watch`, { callsign: "DL1ABC", on: true }, ANON);
ok(
  "favourite and watch need a session or the ingest secret -> 401",
  favAnon.status === 401 && watchAnon.status === 401,
  `fav=${favAnon.status} watch=${watchAnon.status}`,
);
const det = await call("GET", `/api/caches/${id}?callsign=DL1ABC`);
ok(
  "detail carries favorite + health fields",
  det.data?.cache?.favorited === true && typeof det.data?.cache?.needsMaintenance === "boolean",
  JSON.stringify({ favorited: det.data?.cache?.favorited, nm: det.data?.cache?.needsMaintenance }),
);
const act = await call("GET", "/api/activity?limit=10");
ok(
  "activity feed returns recent logs",
  Array.isArray(act.data?.activity) && act.data.activity.length >= 1,
  JSON.stringify(act.data?.activity?.length),
);

// ---- the shack — packet inspector + live station registry ----
const dec = await call("POST", "/api/decode", {
  raw: "OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.00N/01526.00E>088/036Going home",
});
ok(
  "decode parses an uncompressed position",
  dec.data?.ok === true && dec.data?.data?.kind === "position" && Math.abs((dec.data?.data?.lat ?? 0) - 47.0667) < 0.01,
  JSON.stringify(dec.data?.data),
);
ok(
  "decode classifies the q-construct (rf)",
  dec.data?.frame?.heardVia === "rf" && dec.data?.frame?.igateCall === "OE8XXX",
  JSON.stringify(dec.data?.frame),
);
const decBad = await call("POST", "/api/decode", { raw: "not a frame" });
ok("decode rejects a non-frame -> 400", decBad.status === 400, `status=${decBad.status}`);

// ingest a moving station + a weather station, then read them back from the registry
const wbIngest = await call(
  "POST",
  "/ingest",
  {
    packets: [
      {
        src: "OE1MOB-9",
        dst: "APRS",
        path: ["WIDE1-1", "qAR", "OE8XXX"],
        payload: "!4704.00N/01526.00E>088/036",
        kind: "position",
        heardVia: "rf",
        igateCall: "OE8XXX",
        port: "aprs-is",
        ts: now(),
      },
      {
        src: "OE1WX",
        dst: "APRS",
        path: ["TCPIP*", "qAC", "T2"],
        payload: "!4705.00N/01527.00E_220/004g005t077r000p000P000h50b09900",
        kind: "weather",
        heardVia: "aprs_is",
        port: "aprs-is",
        ts: now(),
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);
ok(
  "ingest stores 2 enriched stations",
  wbIngest.data?.ok === true && wbIngest.data?.stored === 2,
  JSON.stringify(wbIngest.data),
);

const stations = await call("GET", "/api/stations?bbox=15,46,16,48");
const mob = (stations.data?.stations ?? []).find((s) => s.callsign === "OE1MOB-9");
ok(
  "station registry returns the moving station with course + symbol",
  mob && mob.course === 88 && mob.symbol === "/>",
  JSON.stringify(mob),
);

const stDetail = await call("GET", "/api/stations/OE1MOB-9");
ok(
  "station detail carries a track",
  (stDetail.data?.station?.track ?? []).length >= 1 && stDetail.data?.station?.packets >= 1,
  JSON.stringify(stDetail.data?.station?.track?.length),
);

const wxDetail = await call("GET", "/api/stations/OE1WX");
ok(
  "weather station detail carries a wx reading",
  wxDetail.data?.station?.wx && Math.abs((wxDetail.data?.station?.wx?.tempC ?? 0) - 25) < 1,
  JSON.stringify(wxDetail.data?.station?.wx),
);

// telemetry/weather time-series for the shack graphs
const mobSeries = await call("GET", "/api/stations/OE1MOB-9/series?window=86400");
ok(
  "station series carries motion telemetry (speed historized on positions)",
  mobSeries.status === 200 && (mobSeries.data?.motion ?? []).some((p) => p.speedKn != null),
  JSON.stringify({ motion: mobSeries.data?.motion }),
);
const wxSeries = await call("GET", "/api/stations/OE1WX/series?window=86400");
ok(
  "station series carries the weather series",
  wxSeries.status === 200 && (wxSeries.data?.wx ?? []).some((p) => p.tempC != null),
  JSON.stringify({ wx: wxSeries.data?.wx }),
);

// raw per-station packet view — verbatim TNC2 frames from the TTL ring
const rawPkts = await call("GET", "/api/stations/OE1MOB-9/packets?limit=10");
ok(
  "station raw packets reconstruct the TNC2 line",
  rawPkts.status === 200 &&
    (rawPkts.data?.packets ?? []).some((p) => typeof p.tnc2 === "string" && p.tnc2.startsWith("OE1MOB-9>")),
  JSON.stringify({ packets: rawPkts.data?.packets }),
);

// ---- interop (CoT/TAK bridge) + transports + messaging ----
const msgIngest = await call(
  "POST",
  "/ingest",
  {
    packets: [
      {
        src: "OE1MOB-9",
        dst: "APRS",
        path: ["TCPIP*", "qAC", "T2"],
        payload: ":OE8APR   :Hello from the field{007",
        kind: "message",
        heardVia: "aprs_is",
        port: "aprs-is",
        ts: now(),
      },
      {
        src: "OE5KISS",
        dst: "APRS",
        path: ["WIDE1-1"],
        payload: "!4704.50N/01526.50E-KISS TNC node",
        kind: "position",
        heardVia: "rf",
        port: "kiss-tnc",
        ts: now(),
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);
ok("ingest accepts a 2nd-transport batch", msgIngest.data?.ok === true, JSON.stringify(msgIngest.data));

const cot = await call("GET", "/api/cot?bbox=15,46,16,48");
const cotXml = typeof cot.data === "string" ? cot.data : "";
const cotRaw = cotXml || (await (await fetch(BASE + "/api/cot?bbox=15,46,16,48")).text());
ok(
  "CoT export is XML with a station event",
  /<events>/.test(cotRaw) && cotRaw.includes('uid="APRS.OE1MOB-9"') && /type="a-f-/.test(cotRaw),
  cotRaw.slice(0, 160),
);

const ports = await call("GET", "/api/ports");
const portList = ports.data?.ports ?? [];
ok(
  "transports registry counts RX per port",
  portList.some((p) => p.port === "aprs-is" && p.rx >= 1) && portList.some((p) => p.port === "kiss-tnc"),
  JSON.stringify(portList),
);

const msgs = await call("GET", "/api/messages?to=OE8APR");
ok(
  "messages feed returns the RX message",
  (msgs.data?.messages ?? []).some((mm) => mm.fromCall === "OE1MOB-9" && /Hello from the field/.test(mm.body)),
  JSON.stringify(msgs.data?.messages?.[0]),
);

// embeddable network badge (SVG, for QRZ.com etc.)
const badgeRes = await fetch(BASE + "/badge/OE8APR.svg");
const badgeSvg = await badgeRes.text();
ok(
  "badge renders SVG with the callsign + finds",
  badgeRes.headers.get("content-type")?.includes("image/svg+xml") &&
    /<svg/.test(badgeSvg) &&
    badgeSvg.includes("OE8APR") &&
    /finds/.test(badgeSvg),
  badgeSvg.slice(0, 80),
);

// ---- audio-cache: staged multi-cache + media ----
const multi = await call("POST", "/api/caches", {
  title: "Staged Hunt",
  type: "multi",
  lat: 47.1,
  lon: 15.5,
  difficulty: 3,
  terrain: 3,
  ownerCall: "OE8APR",
});
const mid = multi.data?.cache?.id;
const setStages = await call("POST", `/api/caches/${mid}/stages`, {
  ownerCall: "OE8APR",
  stages: [
    { stageNo: 0, lat: 47.1, lon: 15.5, radiusM: 60 },
    { stageNo: 1, unlock: "geo", clue: "listen to the clue, then walk north", lat: 47.11, lon: 15.51, radiusM: 60 },
    { stageNo: 2, unlock: "open", clue: "the final cache", lat: 47.12, lon: 15.52 },
  ],
});
ok("owner sets stages", setStages.data?.ok === true && setStages.data?.stages === 3, JSON.stringify(setStages.data));
const notOwner = await call("POST", `/api/caches/${mid}/stages`, { ownerCall: "DL9NO", stages: [] });
ok("non-owner cannot set stages -> 403", notOwner.status === 403, `status=${notOwner.status}`);

// upload an audio clue to stage 1 (raw audio body)
const upRes = await fetch(`${BASE}/api/caches/${mid}/stages/1/media`, {
  method: "PUT",
  headers: { "content-type": "audio/mpeg", "x-owner-call": "OE8APR", "x-ingest-secret": SECRET },
  body: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]),
});
const upJson = await upRes.json().catch(() => ({}));
ok("owner uploads an audio clue", upRes.status === 200 && typeof upJson.mediaKey === "string", JSON.stringify(upJson));
// stage 1 unlocks by location, so its clip is part of what unlocking reveals: hidden until then
const lockedClip = await fetch(`${BASE}/api/media/${upJson.mediaKey}`);
ok("a locked location stage's clip stays hidden", lockedClip.status === 404, `status=${lockedClip.status}`);

// a finder sees stage 0 coords + the clue, but stage 1/2 coords are hidden
const stagesView = await call("GET", `/api/caches/${mid}/stages?callsign=DL1ABC`);
const sv = stagesView.data?.stages ?? [];
ok(
  "stage 0 visible, later stages hidden until unlocked",
  sv[0]?.lat === 47.1 && sv[1]?.lat === null && !sv[1]?.mediaUrl && sv[1]?.clue === null && sv[2]?.lat === null,
  JSON.stringify(sv.map((s) => ({ n: s.stageNo, lat: s.lat, clue: s.clue, media: s.mediaUrl }))),
);

// unlock stage 1: too far -> 403, then within the stage-0 radius -> revealed
const tooFar = await call("POST", `/api/caches/${mid}/stages/1/unlock`, {
  callsign: "DL1ABC",
  appGeo: { lat: 47.3, lon: 15.5 },
});
ok(
  "unlock rejected when too far",
  tooFar.status === 403 && tooFar.data?.reason === "too_far",
  JSON.stringify(tooFar.data),
);
const unlock1 = await call("POST", `/api/caches/${mid}/stages/1/unlock`, {
  callsign: "DL1ABC",
  appGeo: { lat: 47.1001, lon: 15.5001 },
});
ok(
  "unlock at the previous stage reveals coords",
  unlock1.data?.unlocked === true && Math.abs((unlock1.data?.lat ?? 0) - 47.11) < 0.001,
  JSON.stringify(unlock1.data),
);
const mediaRes = await fetch(`${BASE}/api/media/${upJson.mediaKey}?callsign=DL1ABC`, {
  headers: { "x-ingest-secret": SECRET },
});
ok(
  "the clip is served as audio once its stage is unlocked",
  mediaRes.status === 200 && (mediaRes.headers.get("content-type") || "").includes("audio/"),
  `status=${mediaRes.status}`,
);
const unlockAnon = await call("POST", `/api/caches/${mid}/stages/2/unlock`, { callsign: "DL1ABC" }, ANON);
ok("unlock for a named callsign without a session -> 401", unlockAnon.status === 401, `status=${unlockAnon.status}`);
const unlock2 = await call("POST", `/api/caches/${mid}/stages/2/unlock`, { callsign: "DL1ABC" });
ok(
  "open final stage unlocks after reaching stage 1",
  unlock2.data?.unlocked === true && Math.abs((unlock2.data?.lat ?? 0) - 47.12) < 0.001,
  JSON.stringify(unlock2.data),
);

const mdetail = await call("GET", `/api/caches/${mid}`);
ok("detail reports stageCount", mdetail.data?.cache?.stageCount === 3, JSON.stringify(mdetail.data?.cache?.stageCount));

// cache media gallery — owner uploads an image, it lists + serves, non-owner can't delete, owner can
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const addMedia = await fetch(`${BASE}/api/caches/${mid}/media?title=Hint%20photo`, {
  method: "POST",
  headers: { "content-type": "image/png", "x-owner-call": "OE8APR", "x-ingest-secret": SECRET },
  body: pngBytes,
});
const addJson = await addMedia.json().catch(() => ({}));
ok(
  "owner adds cache media (image)",
  addMedia.status === 201 && addJson.item?.kind === "image" && typeof addJson.item?.url === "string",
  JSON.stringify(addJson),
);
const mediaList = await call("GET", `/api/caches/${mid}/media`);
ok(
  "cache media lists the item",
  (mediaList.data?.media ?? []).some((x) => x.id === addJson.item?.id && x.kind === "image"),
  JSON.stringify(mediaList.data?.media),
);
const servedMedia = await fetch(`${BASE}${addJson.item?.url}`);
ok(
  "cache media is served back",
  servedMedia.status === 200 && (servedMedia.headers.get("content-type") || "").includes("image/"),
  `status=${servedMedia.status}`,
);
const delNonOwner = await fetch(`${BASE}/api/caches/${mid}/media/${addJson.item?.id}`, {
  method: "DELETE",
  headers: { "x-owner-call": "DL9NO", "x-ingest-secret": SECRET },
});
ok("non-owner cannot delete cache media -> 403", delNonOwner.status === 403, `status=${delNonOwner.status}`);
const delOwner = await fetch(`${BASE}/api/caches/${mid}/media/${addJson.item?.id}`, {
  method: "DELETE",
  headers: { "x-owner-call": "OE8APR", "x-ingest-secret": SECRET },
});
ok("owner deletes cache media", delOwner.status === 200, `status=${delOwner.status}`);

// living-cache rendezvous — two opted-in living caches co-located + both beaconing log each other
const lcA = await call("POST", "/api/caches", {
  title: "Living A",
  type: "aprs_living",
  lat: 47.5,
  lon: 15.7,
  ownerCall: "OE7RVA",
  stationCall: "OE7RVA-9",
  rendezvous: true,
});
const lcB = await call("POST", "/api/caches", {
  title: "Living B",
  type: "aprs_living",
  lat: 47.5,
  lon: 15.7,
  ownerCall: "OE7RVB",
  stationCall: "OE7RVB-9",
  rendezvous: true,
});
ok(
  "two rendezvous living caches created",
  lcA.status === 201 && lcB.status === 201,
  JSON.stringify({ a: lcA.status, b: lcB.status }),
);
// beacon B first (so it's in the registry), then A co-located → A's ingest detects the meeting
await call("POST", "/ingest", {
  packets: [
    {
      src: "OE7RVB-9",
      dst: "APRS",
      path: ["TCPIP*", "qAC", "T2"],
      payload: "!4730.00N/01542.00E>",
      kind: "position",
      heardVia: "aprs_is",
      port: "aprs-is",
      ts: now(),
    },
  ],
});
await call("POST", "/ingest", {
  packets: [
    {
      src: "OE7RVA-9",
      dst: "APRS",
      path: ["TCPIP*", "qAC", "T2"],
      payload: "!4730.00N/01542.00E>",
      kind: "position",
      heardVia: "aprs_is",
      port: "aprs-is",
      ts: now(),
    },
  ],
});
const rdvA = await call("GET", `/api/caches/${lcA.data?.cache?.id}`);
ok(
  "rendezvous recorded on the beaconing living cache",
  (rdvA.data?.cache?.rendezvous ?? []).some((r) => r.withCall === "OE7RVB-9"),
  JSON.stringify(rdvA.data?.cache?.rendezvous),
);
const rdvB = await call("GET", `/api/caches/${lcB.data?.cache?.id}`);
ok(
  "rendezvous is mutual (shows on the other living cache)",
  (rdvB.data?.cache?.rendezvous ?? []).some((r) => r.withCall === "OE7RVA-9"),
  JSON.stringify(rdvB.data?.cache?.rendezvous),
);

// NFC stage unlock — present the tag's secret (or type it as the manual-code fallback)
const nfcCache = await call("POST", "/api/caches", {
  title: "Tag Hunt",
  type: "multi",
  lat: 47.2,
  lon: 15.6,
  ownerCall: "OE8APR",
});
const nid = nfcCache.data?.cache?.id;
await call("POST", `/api/caches/${nid}/stages`, {
  ownerCall: "OE8APR",
  stages: [
    { stageNo: 0, lat: 47.2, lon: 15.6, radiusM: 60 },
    { stageNo: 1, unlock: "nfc", secret: "TAG-7F3A", clue: "tap the tag at the trailhead", lat: 47.21, lon: 15.61 },
  ],
});
const nfcView = await call("GET", `/api/caches/${nid}/stages?callsign=DL1ABC`);
ok(
  "nfc stage never exposes its secret",
  (nfcView.data?.stages ?? []).every((s) => !("unlockSecret" in s) && !("secret" in s)),
  JSON.stringify(nfcView.data?.stages?.[1]),
);
const nfcNoCode = await call("POST", `/api/caches/${nid}/stages/1/unlock`, { callsign: "DL1ABC" });
ok(
  "nfc unlock without a code -> 403",
  nfcNoCode.status === 403 && nfcNoCode.data?.reason === "no_code",
  JSON.stringify(nfcNoCode.data),
);
const nfcBad = await call("POST", `/api/caches/${nid}/stages/1/unlock`, { callsign: "DL1ABC", code: "WRONG" });
ok(
  "nfc unlock with the wrong code -> 403 bad_code",
  nfcBad.status === 403 && nfcBad.data?.reason === "bad_code",
  JSON.stringify(nfcBad.data),
);
const nfcOk = await call("POST", `/api/caches/${nid}/stages/1/unlock`, { callsign: "DL1ABC", code: "tag-7f3a" });
ok(
  "nfc unlock with the right code (case-insensitive) reveals coords",
  nfcOk.data?.unlocked === true && Math.abs((nfcOk.data?.lat ?? 0) - 47.21) < 0.001,
  JSON.stringify(nfcOk.data),
);
const peek = await call("GET", `/api/caches/${mid}/stages?callsign=DL1ABC`, undefined, ANON);
ok(
  "a stranger naming a finder sees only the public start",
  peek.data?.stages?.[1]?.lat === null && peek.data?.stages?.[1]?.unlocked === false,
  JSON.stringify(peek.data?.stages?.[1]),
);
let guess;
for (let i = 0; i < 11; i++)
  guess = await call("POST", `/api/caches/${nid}/stages/1/unlock`, { callsign: "DL7RL", code: `WRONG${i}` });
ok(
  "NFC code guessing stops after 10 tries an hour -> 429",
  guess.status === 429 && guess.data?.reason === "limited",
  JSON.stringify(guess.data),
);

// ---- account data lifecycle: GDPR export/erasure + portability (signed by a registered key) ----
const accMsg = (action, cs, at) =>
  stableStringify({ v: 1, action, callsign: cs.toUpperCase(), instance: wk.data?.instance, at });
const signAct = async (action, cs, at) =>
  b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(accMsg(action, cs, at))));

const unsignedExportRes = await call("POST", "/api/account/DL1ABC/export", {});
ok(
  "account export without a signed action -> 401",
  unsignedExportRes.status === 401,
  `status=${unsignedExportRes.status}`,
);

let aAt = now();
const exp = await call("POST", "/api/account/DL1ABC/export", {
  key: pubRaw,
  sig: await signAct("export", "DL1ABC", aAt),
  at: aAt,
});
ok(
  "GDPR export returns the caller's data",
  exp.data?.callsign === "DL1ABC" &&
    Array.isArray(exp.data?.keys) &&
    exp.data.keys.length >= 1 &&
    Array.isArray(exp.data?.logs),
  JSON.stringify({ keys: exp.data?.keys?.length, logs: exp.data?.logs?.length }),
);

// migration: import a fresh callsign from a (foreign) bundle, proven by a device-key assertion
const kp2 = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub2 = b64u(await crypto.subtle.exportKey("raw", kp2.publicKey));
const mAt = now();
const mSig = b64u(
  await crypto.subtle.sign("Ed25519", kp2.privateKey, new TextEncoder().encode(accMsg("migrate", "OE9NEW", mAt))),
);
const imp = await call("POST", "/api/account/import", {
  bundle: {
    v: 1,
    instance: "oe.source.example",
    callsign: "OE9NEW",
    verified: true,
    keys: [{ publicKey: pub2, label: "phone", verified: 1 }],
    at: mAt,
  },
  assertion: { key: pub2, sig: mSig, at: mAt },
});
ok(
  "account import claims the callsign + keys",
  imp.data?.ok === true && imp.data?.importedKeys === 1,
  JSON.stringify(imp.data),
);
const movedKeys = await call("GET", "/keys/OE9NEW");
ok(
  "imported device key is present on the target",
  (movedKeys.data?.keys ?? []).some((k) => k.publicKey === pub2),
  JSON.stringify(movedKeys.data?.keys?.length),
);
const impDup = await call("POST", "/api/account/import", {
  bundle: { callsign: "OE9NEW", keys: [{ publicKey: pub2 }] },
  assertion: { key: pub2, sig: mSig, at: mAt },
});
ok("re-importing an existing callsign -> 409", impDup.status === 409, `status=${impDup.status}`);

// erasure: anonymise + remove DL1ABC, then confirm it's gone
aAt = now();
const del = await call("POST", "/api/account/DL1ABC/delete", {
  key: pubRaw,
  sig: await signAct("delete", "DL1ABC", aAt),
  at: aAt,
});
ok("GDPR erasure succeeds", del.data?.ok === true && del.data?.erased === "DL1ABC", JSON.stringify(del.data));
const goneKeys = await call("GET", "/keys/DL1ABC");
ok(
  "erased account keys are removed",
  (goneKeys.data?.keys ?? []).length === 0,
  JSON.stringify(goneKeys.data?.keys?.length),
);
const goneProf = await call("GET", "/api/profile/DL1ABC");
ok("erased account finds are anonymised away", (goneProf.data?.finds ?? 0) === 0, JSON.stringify(goneProf.data?.finds));

// ---- BBS: personal mail, bulletins and NTS traffic, moved the F6FBB way only ----
const bbsP = await call("POST", "/api/bbs/messages", {
  fromCall: "OE8APR",
  toCall: "OE7BBS",
  body: "meet at the summit cache",
});
ok(
  "BBS accepts a personal message",
  bbsP.status === 201 && bbsP.data?.type === "P" && bbsP.data?.id > 0,
  JSON.stringify(bbsP.data),
);
const msgId = bbsP.data?.id;
const bbsB = await call("POST", "/api/bbs/messages", {
  fromCall: "OE8APR",
  toCall: "ALL",
  body: "net tonight 8pm local",
});
ok("BBS accepts a bulletin", bbsB.data?.type === "B", JSON.stringify(bbsB.data));

// FBB thread tree + typing + SR (reply chains into a thread; T traffic typing)
ok(
  "a root personal message threads to itself",
  bbsP.data?.threadId === msgId,
  JSON.stringify({ threadId: bbsP.data?.threadId, msgId }),
);
const bbsReply = await call("POST", "/api/bbs/messages", {
  fromCall: "OE7BBS",
  toCall: "OE8APR",
  subject: "Re: meet",
  body: "ok see you there",
  replyTo: msgId,
});
ok(
  "SR reply inherits the parent's thread root",
  bbsReply.data?.replyTo === msgId && bbsReply.data?.threadId === msgId,
  JSON.stringify(bbsReply.data),
);
const thread = await call("GET", `/api/bbs/thread/${msgId}`);
ok(
  "thread view returns root + reply oldest-first",
  thread.data?.threadId === msgId &&
    (thread.data?.messages ?? []).length >= 2 &&
    thread.data.messages[0].id === msgId &&
    thread.data.messages.some((m) => m.replyTo === msgId),
  JSON.stringify(thread.data?.messages?.map((m) => ({ id: m.id, replyTo: m.replyTo }))),
);
const bbsT = await call("POST", "/api/bbs/messages", {
  fromCall: "OE8APR",
  toCall: "OE3XYZ",
  type: "T",
  body: "QTC 1 msg",
});
ok("BBS accepts NTS traffic (type T)", bbsT.data?.type === "T", JSON.stringify(bbsT.data));

// forwarding + hierarchical routing + White Pages
const fwdDefault = await call("GET", `/api/bbs/route?addr=${encodeURIComponent("W1AW @ W1XYZ.MA.USA.NOAM")}`);
ok(
  "unmatched address routes to the ip-fed catch-all",
  fwdDefault.data?.partner?.partner === "ip-fed",
  JSON.stringify(fwdDefault.data?.partner),
);
const addRule = await call("POST", "/api/bbs/forward", { partner: "rf-oe", route: "OE", transport: "rf-fbb" });
ok("sysop can add a forward rule", addRule.status === 201 && addRule.data?.id > 0, JSON.stringify(addRule.data));
const fwdOe = await call("GET", `/api/bbs/route?addr=${encodeURIComponent("OE8APR @ OE8XBM.#OE3.OE.EU")}`);
ok(
  "an OE address routes to the more-specific rf-oe partner",
  fwdOe.data?.partner?.partner === "rf-oe",
  JSON.stringify(fwdOe.data?.partner),
);
const wpSet = await call("POST", "/api/bbs/wp", { callsign: "OE8APR", homeBbs: "OE8XBM.OE.EU" });
ok(
  "White Pages stores a home BBS (with its H-route)",
  wpSet.data?.ok === true && wpSet.data?.homeBbs === "OE8XBM.OE.EU",
  JSON.stringify(wpSet.data),
);
const wpRoute = await call("GET", "/api/bbs/route?to=OE8APR");
ok(
  "a bare callsign is steered via White Pages then routed",
  /OE8XBM/.test(wpRoute.data?.addr ?? "") && wpRoute.data?.partner?.partner === "rf-oe",
  JSON.stringify(wpRoute.data),
);

// NET/ROM node — MHeard populated from ingest + sysop NODES table
const mheard = await call("GET", "/api/node/mheard");
ok(
  "node MHeard lists stations heard via ingest",
  (mheard.data?.mheard ?? []).some((x) => x.callsign === "OE1MOB-9" && x.port === "aprs-is"),
  JSON.stringify(mheard.data?.mheard?.slice(0, 3)),
);
const addNode = await call("POST", "/api/node/nodes", {
  dest: "OE8XBM-7",
  alias: "GRAZ",
  neighbor: "OE8REL-7",
  quality: 200,
  port: "kiss-tnc",
});
ok(
  "sysop adds a NET/ROM node route",
  addNode.status === 201 && addNode.data?.dest === "OE8XBM-7",
  JSON.stringify(addNode.data),
);
const nodes = await call("GET", "/api/node/nodes");
ok(
  "NODES table lists the route",
  (nodes.data?.nodes ?? []).some((n) => n.alias === "GRAZ" && n.neighbor === "OE8REL-7"),
  JSON.stringify(nodes.data?.nodes),
);

const list1 = await call("GET", "/api/bbs/messages?to=OE7BBS");
ok(
  "personal mail waits in the BBS, unread",
  (list1.data?.messages ?? []).some((mm) => mm.id === msgId && mm.readAt == null),
  JSON.stringify(list1.data?.messages?.[0]),
);

await call(
  "POST",
  "/ingest",
  {
    packets: [
      {
        src: "OE7BBS",
        dst: "APRS",
        path: ["TCPIP*", "qAC", "T2"],
        payload: "!4704.00N/01526.00E>",
        kind: "position",
        heardVia: "aprs_is",
        port: "aprs-is",
        ts: now(),
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);
const outbox = await call("GET", "/outbox", undefined, { "x-ingest-secret": SECRET });
ok(
  "the BBS sends nothing over APRS when the addressee is heard",
  outbox.status === 200 && !(outbox.data?.items ?? []).some((it) => /OE7BBS/.test(it.payload ?? "")),
  JSON.stringify(outbox.data?.items),
);

const bulls = await call("GET", "/api/bbs/bulletins");
ok(
  "bulletin board lists the bulletin",
  (bulls.data?.bulletins ?? []).some((bb) => /net tonight/.test(bb.body) && bb.type === "B"),
  JSON.stringify(bulls.data?.bulletins?.length),
);

// ---- sitemap + RSS feeds: machine-readable site map and feeds over the public data ----
const text = async (path) => {
  const r = await fetch(BASE + path);
  return { status: r.status, ct: r.headers.get("content-type") ?? "", body: await r.text() };
};
const smap = await text("/sitemap.xml");
ok(
  "sitemap.xml is XML with a urlset + ?view= deep-links",
  smap.status === 200 && /xml/.test(smap.ct) && smap.body.includes("<urlset") && smap.body.includes("?view=shack"),
  `${smap.status} ${smap.ct}`,
);
const smapJson = await call("GET", "/api/sitemap");
ok(
  "/api/sitemap lists surfaces + feeds with urls",
  (smapJson.data?.surfaces ?? []).length > 0 &&
    (smapJson.data?.feeds ?? []).some((f) => f.url?.endsWith("/feeds/activity.xml")),
  JSON.stringify(smapJson.data?.feeds?.length),
);
const robots = await text("/robots.txt");
ok(
  "robots.txt advertises the sitemap",
  robots.body.includes("Sitemap:") && robots.body.includes("/sitemap.xml"),
  robots.body.split("\n")[0],
);

const actFeed = await text("/feeds/activity.xml");
ok(
  "activity RSS has items for the seeded finds",
  /application\/rss\+xml/.test(actFeed.ct) && actFeed.body.includes("<rss") && actFeed.body.includes("<item>"),
  `${actFeed.status} ${actFeed.ct}`,
);
const cacheFeed = await text("/feeds/caches.xml");
ok(
  "new-caches RSS lists a seeded cache",
  cacheFeed.body.includes("<rss") && /<item>/.test(cacheFeed.body),
  `${cacheFeed.status}`,
);
const bullFeed = await text("/feeds/bulletins.xml");
ok("bulletins RSS carries the bulletin", bullFeed.body.includes("net tonight"), `${bullFeed.status}`);
const lbFeed = await text("/feeds/leaderboard.xml");
ok(
  "leaderboard RSS is a valid channel",
  lbFeed.body.includes("<rss") && lbFeed.body.includes("<channel>"),
  `${lbFeed.status}`,
);
const userFeed = await text("/feeds/u/OE8APR.xml");
ok(
  "user RSS feed renders for a callsign",
  userFeed.body.includes("<rss") && userFeed.body.includes("OE8APR"),
  `${userFeed.status}`,
);

// ---- live activity spots: read-only, off by default, well-formed empty payload ----
const spots = await call("GET", "/api/spots?bbox=14,46,16,48&bands=20m");
ok(
  "/api/spots responds with the spots envelope (disabled by default → empty)",
  spots.status === 200 &&
    spots.data?.enabled === false &&
    Array.isArray(spots.data?.spots) &&
    spots.data.spots.length === 0,
  JSON.stringify(spots.data),
);

// ---- public read API: versioned, rate-limited, free keys, read-only ----
const apiIdx = await call("GET", "/api/v1");
ok(
  "/api/v1 index lists version + limits + endpoints",
  apiIdx.status === 200 &&
    apiIdx.data?.version === "v1" &&
    apiIdx.data?.rateLimits?.with_key > apiIdx.data?.rateLimits?.anonymous &&
    Array.isArray(apiIdx.data?.endpoints),
  JSON.stringify(apiIdx.data?.rateLimits),
);
const keyOwner = await signUp("OE7KEY");
const issueRes = await call("POST", "/api/keys", { name: "smoke" }, { cookie: keyOwner });
const apiKey = issueRes.data?.key;
ok(
  "POST /api/keys gives a signed-in account a free key",
  issueRes.status === 201 && typeof apiKey === "string" && apiKey.startsWith("acg_"),
  // the issued key is a credential: report its shape, never its value
  `status=${issueRes.status} key=${typeof apiKey === "string" ? "issued (value redacted)" : "missing"}`,
);
const anonKey = await call("POST", "/api/v1/keys", { label: "smoke" });
ok("POST /api/v1/keys mints no anonymous key (410)", anonKey.status === 410, String(anonKey.status));
const v1caches = await call("GET", "/api/v1/caches?bbox=14,46,16,48", undefined, { authorization: "Bearer " + apiKey });
ok(
  "GET /api/v1/caches (keyed) returns seeded caches",
  v1caches.status === 200 && (v1caches.data?.caches ?? []).length > 0,
  JSON.stringify(v1caches.data?.caches?.length),
);
const v1code = (v1caches.data?.caches ?? [])[0]?.code;
const v1detail = v1code ? await call("GET", "/api/v1/caches/" + v1code) : { status: 0, data: {} };
ok(
  "GET /api/v1/caches/:code returns cache detail",
  v1detail.status === 200 && v1detail.data?.cache?.code === v1code,
  JSON.stringify({ v1code, got: v1detail.data?.cache?.code }),
);
const v1big = await call("GET", "/api/v1/caches?bbox=-60,-60,60,60");
ok("GET /api/v1 caps an oversized bbox (400)", v1big.status === 400, JSON.stringify(v1big.data));
const v1write = await call("POST", "/api/v1/caches", {});
ok("/api/v1 is read-only (write → 405)", v1write.status === 405, String(v1write.status));

// read-API exports: GPX / KML / ADIF
const gpx = await text("/api/v1/caches.gpx?bbox=14,46,16,48");
ok(
  "GET /api/v1/caches.gpx exports GPX waypoints",
  gpx.status === 200 && /gpx\+xml/.test(gpx.ct) && gpx.body.includes("<wpt lat="),
  `${gpx.status} ${gpx.ct}`,
);
const kml = await text("/api/v1/caches.kml?bbox=14,46,16,48");
ok(
  "GET /api/v1/caches.kml exports KML placemarks",
  kml.status === 200 && /kml/.test(kml.ct) && kml.body.includes("<Placemark>"),
  `${kml.status} ${kml.ct}`,
);
const gpx1 = v1code ? await text("/api/v1/caches/" + v1code + ".gpx") : { status: 0, body: "" };
ok(
  "GET /api/v1/caches/:code.gpx exports a single cache",
  gpx1.status === 200 && gpx1.body.includes(`<name>${v1code}</name>`),
  `${gpx1.status}`,
);
const adif = await text("/api/v1/profile/OE8APR.adif");
ok(
  "GET /api/v1/profile/:call.adif exports ADIF",
  adif.status === 200 && /ADIF_VER/.test(adif.body) && adif.body.includes("<EOH>"),
  `${adif.status} ${adif.ct}`,
);
const v1corr = await call("GET", "/api/v1/corroborators");
ok(
  "GET /api/v1/corroborators ranks the gating IGate",
  v1corr.status === 200 && (v1corr.data?.corroborators ?? []).some((c) => c.igate === "OE8XXX"),
  JSON.stringify(v1corr.data?.corroborators),
);
ok(
  "GET /api/v1 index lists corroborators",
  (apiIdx.data?.endpoints ?? []).some((e) => e.path.startsWith("/api/v1/corroborators")),
  "index missing corroborators",
);

// station tracks + embed widget + QR
const track = await call("GET", "/api/v1/station/OE7BBS/track");
ok(
  "GET /api/v1/station/:call/track returns position history",
  track.status === 200 && Array.isArray(track.data?.positions),
  JSON.stringify({ count: track.data?.count }),
);
const tkml = await text("/api/v1/station/OE7BBS.kml");
ok(
  "GET /api/v1/station/:call.kml returns a KML track",
  tkml.status === 200 && /kml/.test(tkml.ct) && tkml.body.includes("<LineString>"),
  `${tkml.status} ${tkml.ct}`,
);
const embed = await text("/embed?cache=" + (v1code || "AC-0001"));
ok(
  "GET /embed serves an HTML map widget",
  embed.status === 200 && /text\/html/.test(embed.ct) && embed.body.includes("maplibre-gl"),
  `${embed.status} ${embed.ct}`,
);
const qr = await text("/embed/qr.svg?cache=" + (v1code || "AC-0001"));
ok(
  "GET /embed/qr.svg returns an SVG QR",
  qr.status === 200 && /svg\+xml/.test(qr.ct) && qr.body.startsWith("<svg"),
  `${qr.status} ${qr.ct}`,
);

// remote station control: the box command channel
const boxRx = await call("POST", "/api/box/smoke-box/command", { kind: "status" });
ok(
  "POST /api/box/:id/command enqueues a read command",
  boxRx.status === 201 && boxRx.data?.status === "queued",
  JSON.stringify(boxRx.data),
);
const boxTxUnver = await call("POST", "/api/box/smoke-box/command", {
  kind: "beacon",
  callsign: "OE5XYZ",
  payload: { lat: 47, lon: 15 },
});
ok("a TX command for an unverified callsign is blocked (403)", boxTxUnver.status === 403, String(boxTxUnver.status));
await verifyCallsign("OE7BOX", await signUp("OE7BOX")); // control-verify a fresh call (DL1ABC was GDPR-erased earlier)
const boxTx = await call("POST", "/api/box/smoke-box/command", {
  kind: "message",
  callsign: "OE7BOX",
  payload: { to: "OE3ABC", text: "hi" },
});
ok(
  "a TX command for a verified callsign is queued (control-verified)",
  boxTx.status === 201 && boxTx.data?.tx === true,
  JSON.stringify(boxTx.data),
);
const boxPoll = await call("GET", "/api/box/smoke-box/commands");
ok(
  "the box leases its queued commands (secret)",
  boxPoll.status === 200 && (boxPoll.data?.commands ?? []).length >= 2,
  JSON.stringify((boxPoll.data?.commands ?? []).map((c) => c.kind)),
);
const boxPoll2 = await call("GET", "/api/box/smoke-box/commands");
ok(
  "leased commands are not re-delivered",
  (boxPoll2.data?.commands ?? []).length === 0,
  JSON.stringify(boxPoll2.data?.commands?.length),
);
const boxNoSecret = await fetch(`${BASE}/api/box/smoke-box/commands`);
ok("box poll without the secret is rejected (401)", boxNoSecret.status === 401, String(boxNoSecret.status));
const boxAck = await call("POST", "/api/box/smoke-box/commands/ack", {
  id: (boxPoll.data?.commands ?? [])[0]?.id,
  status: "done",
  result: "ok",
});
ok("the box acks execution", boxAck.status === 200 && boxAck.data?.ok === true, JSON.stringify(boxAck.data));
{
  // a message the box sent shows in the Messages list as sent, once however often the box reports it
  const msgCmd = (boxPoll.data?.commands ?? []).find((c) => c.kind === "message");
  for (let i = 0; i < 2; i++)
    await call("POST", "/api/box/smoke-box/commands/ack", { id: msgCmd?.id, status: "done", result: "ok" });
  const sentRows = ((await call("GET", "/api/messages")).data?.messages ?? []).filter(
    (m) => m.fromCall === "OE7BOX" && m.toCall === "OE3ABC" && m.body === "hi",
  );
  ok(
    "a message the box sent is listed once, as sent",
    sentRows.length === 1 && sentRows[0].direction === "tx",
    JSON.stringify(sentRows),
  );
}
const boxLog = await call("GET", "/api/box/smoke-box/log");
// a signed-in operator controls a box only after pairing it with the code the box obtained
{
  const pc = await signUp("OE7PAIR");
  const squat = await call(
    "POST",
    "/api/box/smoke-box/command",
    { kind: "status" },
    { cookie: pc, "x-ingest-secret": "" },
  );
  ok(
    "an unpaired box refuses a session's command (no first-touch squatting)",
    squat.status === 403,
    String(squat.status),
  );
  const minted = await call("POST", "/api/box/smoke-box/pair", {});
  ok(
    "the box obtains a pairing code with its secret",
    /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(minted.data?.code ?? ""),
    JSON.stringify(minted.data),
  );
  const claimed = await call(
    "POST",
    "/api/box/smoke-box/claim",
    { code: minted.data?.code },
    { cookie: pc, "x-ingest-secret": "" },
  );
  ok("the pairing code links the box to the account", claimed.status === 200, JSON.stringify(claimed.data));
  const own = await call(
    "POST",
    "/api/box/smoke-box/command",
    { kind: "status" },
    { cookie: pc, "x-ingest-secret": "" },
  );
  ok("the paired owner's session commands the box", own.status === 201, JSON.stringify(own.data));
}
ok(
  "the operator sees the box command log",
  boxLog.status === 200 && (boxLog.data?.commands ?? []).some((c) => c.status === "done"),
  JSON.stringify((boxLog.data?.commands ?? []).map((c) => `${c.kind}:${c.status}`)),
);

// watchlist + alerts — fresh session, watch a call, hear it near the smoke cache
const wStart = await call("POST", "/auth/email/start", { email: `w${now()}@example.com`, callsign: "OE9WL" });
const wVer = await fetch(`${BASE}/auth/email/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: wStart.data?.devToken }),
});
const wcookie = (wVer.headers.get("set-cookie") ?? "").split(";")[0];
ok("watchlist requires a session (401)", (await fetch(`${BASE}/api/watch`)).status === 401);
const wAdd = await fetch(`${BASE}/api/watch`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: wcookie },
  body: JSON.stringify({ callsign: "OE9WX-7" }),
});
ok(
  "POST /api/watch adds the base callsign",
  wAdd.status === 201 && (await wAdd.json()).callsign === "OE9WX",
  String(wAdd.status),
);
const wList = await (await fetch(`${BASE}/api/watch`, { headers: { cookie: wcookie } })).json();
ok(
  "GET /api/watch lists the watched call",
  (wList.watching ?? []).some((w) => w.callsign === "OE9WX"),
  JSON.stringify(wList),
);
await call(
  "POST",
  "/ingest",
  {
    packets: [
      {
        src: "OE9WX-7",
        path: ["WIDE1-1", "qAR", "OE8X"],
        payload: "=4704.41N/01526.27E>",
        kind: "position",
        parsed: { lat: 47.0735, lon: 15.4378, symbol: ">" },
        heardVia: "rf",
        igateCall: "OE8X",
        port: "aprs-is",
        ts: now(),
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);
const wAlerts = await (await fetch(`${BASE}/api/watch/alerts`, { headers: { cookie: wcookie } })).json();
ok(
  "a watched callsign heard near a cache raises an alert",
  (wAlerts.alerts ?? []).some((a) => a.callsign === "OE9WX" && (a.kind === "near_cache" || a.kind === "heard")),
  JSON.stringify((wAlerts.alerts ?? []).map((a) => `${a.callsign}:${a.kind}`)),
);
ok(
  "mark alerts seen",
  (await (await fetch(`${BASE}/api/watch/seen`, { method: "POST", headers: { cookie: wcookie } })).json()).ok === true,
);
ok(
  "DELETE /api/watch/:call removes it",
  (await (await fetch(`${BASE}/api/watch/OE9WX`, { method: "DELETE", headers: { cookie: wcookie } })).json()).ok ===
    true,
);

// save / share map views
const vStart = await call("POST", "/auth/email/start", { email: `v${now()}@example.com`, callsign: "OE9VW" });
const vVer = await fetch(`${BASE}/auth/email/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: vStart.data?.devToken }),
});
const vcookie = (vVer.headers.get("set-cookie") ?? "").split(";")[0];
ok(
  "save view requires a session (401)",
  (
    await fetch(`${BASE}/api/views`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: { zoom: 11 } }),
    })
  ).status === 401,
);
const vCreate = await fetch(`${BASE}/api/views`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: vcookie },
  body: JSON.stringify({ name: "Graz", state: { center: [15.43, 47.07], zoom: 12, layers: { spots: true } } }),
});
const vSlug = (await vCreate.json()).slug;
ok(
  "POST /api/views saves a view + returns a slug",
  vCreate.status === 201 && typeof vSlug === "string" && vSlug.length > 0,
  String(vCreate.status),
);
const vResolve = await call("GET", "/v/" + vSlug);
ok(
  "GET /v/:slug resolves a public view",
  vResolve.status === 200 && vResolve.data?.state?.zoom === 12 && vResolve.data?.ownerCall === "OE9VW",
  JSON.stringify(vResolve.data),
);
const vList = await (await fetch(`${BASE}/api/views`, { headers: { cookie: vcookie } })).json();
ok(
  "GET /api/views lists my saved views",
  (vList.views ?? []).some((v) => v.slug === vSlug),
);
ok("GET /v/:slug 404s for an unknown slug", (await call("GET", "/v/zzzz9999")).status === 404);

// push + email-digest delivery — uses the OE9WL session from the watchlist block
ok(
  "GET /api/push/key returns the VAPID key (null unless configured)",
  (await call("GET", "/api/push/key")).status === 200,
);
const pSub = await fetch(`${BASE}/api/push/subscribe`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: wcookie },
  body: JSON.stringify({ endpoint: "https://push.test/abc", keys: { p256dh: "x", auth: "y" } }),
});
ok("POST /api/push/subscribe stores a subscription", pSub.status === 201, String(pSub.status));
ok(
  "push subscribe requires a session (401)",
  (
    await fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "x" }),
    })
  ).status === 401,
);
ok(
  "GET /api/notify/prefs reports the digest opt-in (default on)",
  (await (await fetch(`${BASE}/api/notify/prefs`, { headers: { cookie: wcookie } })).json()).digest === true,
);
await fetch(`${BASE}/api/notify/prefs`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: wcookie },
  body: JSON.stringify({ digest: false }),
});
ok(
  "POST /api/notify/prefs toggles the email digest off",
  (await (await fetch(`${BASE}/api/notify/prefs`, { headers: { cookie: wcookie } })).json()).digest === false,
);

// editable ham profile
const prStart = await call("POST", "/auth/email/start", { email: `p${now()}@example.com`, callsign: "OE9PROF" });
const prVer = await fetch(`${BASE}/auth/email/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: prStart.data?.devToken }),
});
const prcookie = (prVer.headers.get("set-cookie") ?? "").split(";")[0];
ok(
  "profile update requires a session (401)",
  (
    await fetch(`${BASE}/auth/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bio: "x" }),
    })
  ).status === 401,
);
const prUp = await fetch(`${BASE}/auth/profile`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: prcookie },
  body: JSON.stringify({
    displayName: "Andreas",
    homeGrid: "JN77",
    bio: "<i>QRP</i> op",
    links: [{ label: "QRZ", url: "https://qrz.com/db/OE9PROF" }],
    profilePublic: true,
  }),
});
ok(
  "POST /auth/profile updates the profile (sanitised)",
  prUp.status === 200 && (await prUp.json()).profile?.bio === "QRP op",
  String(prUp.status),
);
const prGet = await call("GET", "/api/profile/OE9PROF");
ok(
  "GET /api/profile surfaces the public profile",
  prGet.data?.profile?.displayName === "Andreas" && prGet.data?.profile?.homeGrid === "JN77",
  JSON.stringify(prGet.data?.profile),
);
ok(
  "invalid Maidenhead locator rejected (400)",
  (
    await fetch(`${BASE}/auth/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: prcookie },
      body: JSON.stringify({ homeGrid: "ZZ99" }),
    })
  ).status === 400,
);
await fetch(`${BASE}/auth/profile`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: prcookie },
  body: JSON.stringify({ profilePublic: false }),
});
ok(
  "profile hidden when profile_public is off",
  (await call("GET", "/api/profile/OE9PROF")).data?.profile === undefined,
);

// weather user-origination — a weather station in My stations, placed at the home grid when it has no coords
await fetch(`${BASE}/auth/profile`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: prcookie },
  body: JSON.stringify({ displayName: "Andreas", homeGrid: "JN77" }),
});
ok(
  "there is no account-level weather key (404)",
  (await fetch(`${BASE}/api/wx/key`, { method: "POST", headers: { cookie: prcookie } })).status === 404,
);
const wxMk = await (
  await fetch(`${BASE}/api/my/stations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: prcookie },
    body: JSON.stringify({ callsign: "OE9PROF-13", roles: ["weather"] }),
  })
).json();
const wxKey = wxMk.station?.wx ?? {};
ok(
  "an unverified call adds a weather-only station at its home locator, with its push key",
  wxMk.station?.callsign === "OE9PROF-13" && wxMk.station?.lat != null && /^wx_/.test(wxKey.key ?? ""),
  JSON.stringify({ station: wxMk.station?.callsign, lat: wxMk.station?.lat, key: (wxKey.key ?? "").slice(0, 6) }),
);
ok(
  "a weather-only station on an unverified call gains no other role (403)",
  (
    await fetch(`${BASE}/api/my/stations/${wxMk.station?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: prcookie },
      body: JSON.stringify({ roles: ["weather", "digipeater"] }),
    })
  ).status === 403,
);
ok(
  "weather TX on an unverified call is refused (403)",
  (
    await fetch(`${BASE}/api/wx/tx`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: prcookie },
      body: JSON.stringify({ stationId: wxMk.station?.id, txIs: true, txCwop: false }),
    })
  ).status === 403,
);
ok(
  "wx submit with a bad key is rejected (401)",
  (await call("GET", "/api/wx/submit?key=nope&tempf=70")).status === 401,
);
const wxSub = await fetch(
  `${BASE}/api/wx/submit?key=${wxKey.key}&tempf=68&humidity=55&baromrelin=29.92&windspeedmph=10&winddir=180&solarradiation=500&stationtype=EasyWeather`,
);
ok("wx submit (Ecowitt) stores a reading", wxSub.status === 200 && (await wxSub.text()).includes("success"));
const wxStation = await call("GET", "/api/stations/OE9PROF-13");
ok(
  "the -13 weather station carries the pushed reading",
  wxStation.data?.station?.wx && Math.abs((wxStation.data.station.wx.tempC ?? 0) - 20) < 1,
  JSON.stringify(wxStation.data?.station?.wx),
);

// operated-stations registry — manage multiple own stations with explicit locations
ok("my-stations list requires a session (401)", (await call("GET", "/api/my/stations")).status === 401);
// a station belongs to a held, verified call: before verifying, OE9PROF lists none
ok(
  "an unverified call lists no station (403)",
  (
    await fetch(`${BASE}/api/my/stations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: prcookie },
      body: JSON.stringify({ callsign: "OE9PROF-2", lat: 47.62, lon: 13.0 }),
    })
  ).status === 403,
);
ok("the station owner verifies OE9PROF on the air", await verifyCallsign("OE9PROF", prcookie));
const stBad = await fetch(`${BASE}/api/my/stations`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: prcookie },
  body: JSON.stringify({ callsign: "not valid!" }),
});
ok("creating a station with a bad callsign is rejected (400)", stBad.status === 400);
ok(
  "a station needs a location at creation (400)",
  (
    await fetch(`${BASE}/api/my/stations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: prcookie },
      body: JSON.stringify({ callsign: "OE9PROF-5", roles: ["node"] }),
    })
  ).status === 400,
);
const stMk = await (
  await fetch(`${BASE}/api/my/stations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: prcookie },
    body: JSON.stringify({
      callsign: "OE9PROF-2",
      lat: 47.62,
      lon: 15.79,
      description: "Stuhleck digi",
      roles: ["digipeater", "igate"],
    }),
  })
).json();
ok(
  "POST /api/my/stations creates a station at explicit coords + role symbol on the map",
  stMk.station?.callsign === "OE9PROF-2" && stMk.station?.lat === 47.62 && stMk.station?.roles.includes("digipeater"),
  JSON.stringify(stMk.station),
);
const stOnMap = await call("GET", "/api/stations/OE9PROF-2");
ok(
  "the new station shows on the map with its roles",
  (stOnMap.data?.station?.roles ?? []).includes("digipeater") && stOnMap.data?.station?.symbol === "#",
  JSON.stringify({ roles: stOnMap.data?.station?.roles, sym: stOnMap.data?.station?.symbol }),
);
ok(
  "another operator's callsign is not listed (403)",
  (
    await fetch(`${BASE}/api/my/stations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: prcookie },
      body: JSON.stringify({ callsign: "DL9XXX-7", lat: 50.1, lon: 8.6, roles: ["igate"] }),
    })
  ).status === 403,
);
// remove the weather station: its key stops working, and its call stays heard on the map
await fetch(`${BASE}/api/my/stations/${wxMk.station?.id}`, { method: "DELETE", headers: { cookie: prcookie } });
ok(
  "removing a weather station revokes its push key (401)",
  (await call("GET", `/api/wx/submit?key=${wxKey.key}&tempf=70`)).status === 401,
);
// adopt an own station already heard on the map (no coords given → inherit OE9PROF-13's fix)
const adopt = await (
  await fetch(`${BASE}/api/my/stations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: prcookie },
    body: JSON.stringify({ callsign: "OE9PROF-13", roles: ["weather"] }),
  })
).json();
ok(
  "adopt a heard station with no coords inherits its location",
  adopt.station?.callsign === "OE9PROF-13" && adopt.station?.lat != null && adopt.station?.lon != null,
  JSON.stringify(adopt.station),
);
const stWxNo = await fetch(`${BASE}/api/my/stations/${stMk.station.id}/wx-key`, {
  method: "POST",
  headers: { cookie: prcookie },
});
ok("a weather key needs the weather role first (400)", stWxNo.status === 400);
await fetch(`${BASE}/api/my/stations/${stMk.station.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json", cookie: prcookie },
  body: JSON.stringify({ roles: ["digipeater", "igate", "weather"] }),
});
const stWx = await (
  await fetch(`${BASE}/api/my/stations/${stMk.station.id}/wx-key`, { method: "POST", headers: { cookie: prcookie } })
).json();
ok(
  "a weather-capable station issues its own PWS key + URLs",
  /^wx_/.test(stWx.key ?? "") && (stWx.wuUrl ?? "").includes("ID=OE9PROF-2"),
  JSON.stringify({ key: (stWx.key ?? "").slice(0, 6) }),
);
await fetch(`${BASE}/api/wx/submit?key=${stWx.key}&tempf=41&humidity=70&stationtype=EasyWeather`);
const stDet = await call("GET", "/api/stations/OE9PROF-2");
ok(
  "the remote station's reading lands at ITS coords (not the home grid)",
  stDet.data?.station?.wx &&
    Math.abs((stDet.data.station.lat ?? 0) - 47.62) < 0.01 &&
    Math.abs((stDet.data.station.wx.tempC ?? 0) - 5) < 0.5,
  JSON.stringify({ lat: stDet.data?.station?.lat, wx: stDet.data?.station?.wx }),
);
// become-a-cache flows: turn a station into a cache, and put yourself on the map
const s2c = await (
  await fetch(`${BASE}/api/my/stations/${stMk.station.id}/cache`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: prcookie },
    body: JSON.stringify({}),
  })
).json();
ok(
  "turn a station into a cache at its location",
  s2c.cache?.type === "traditional" &&
    Math.abs((s2c.cache?.lat ?? 0) - 47.62) < 0.01 &&
    s2c.cache?.ownerCall === "OE9PROF",
  JSON.stringify(s2c.cache),
);
const meC = await (
  await fetch(`${BASE}/api/me/cache`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: prcookie },
    body: JSON.stringify({}),
  })
).json();
ok(
  "become a cache → a living cache that follows your beacon",
  meC.cache?.type === "aprs_living" && (meC.cache?.stationCall ?? "").startsWith("OE9PROF"),
  JSON.stringify(meC.cache),
);
ok(
  "DELETE /api/my/stations/:id removes it",
  (
    await (
      await fetch(`${BASE}/api/my/stations/${stMk.station.id}`, { method: "DELETE", headers: { cookie: prcookie } })
    ).json()
  ).ok === true,
);

// corroborator leaderboard: the IGate (OE8XXX) that gated the Tier-A find earlier ranks
const board = await call("GET", "/api/corroborators");
ok(
  "corroborator board ranks the gating IGate",
  (board.data?.corroborators ?? []).some((c) => c.igate === "OE8XXX" && c.corroborations >= 1),
  JSON.stringify(board.data?.corroborators),
);
const igProf = await call("GET", "/api/profile/OE8XXX");
ok(
  "an operator's profile shows its Infrastructure corroborations",
  (igProf.data?.corroborations ?? 0) >= 1,
  JSON.stringify(igProf.data?.corroborations),
);

// supporter recognition + public ledger — recognition only, gates nothing
ok(
  "confirm a donation (operator secret) marks supporter + ledgers it",
  (
    await call("POST", "/api/support/confirm", {
      callsign: "OE9PROF",
      amountCents: 500,
      bucket: "hosting",
      source: "manual",
    })
  ).data?.supporter === "OE9PROF",
);
ok(
  "the supporter flag shows on the profile (recognition)",
  (await call("GET", "/api/profile/OE9PROF")).data?.supporter === true,
);
const support = await call("GET", "/api/support");
ok(
  "/api/support exposes the public ledger summary",
  support.data?.ledger?.totalInCents >= 500 && support.data?.supporters?.includes("OE9PROF"),
  JSON.stringify({ in: support.data?.ledger?.totalInCents }),
);
ok("support prefs require a session (401)", (await fetch(`${BASE}/api/support/prefs`)).status === 401);
ok(
  "hide-nag toggles for the session",
  (
    await (
      await fetch(`${BASE}/api/support/prefs`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: prcookie },
        body: JSON.stringify({ hideNag: true }),
      })
    ).json()
  ).hideNag === true,
);
const supPage = await text("/support");
ok(
  "/support renders a public HTML transparency page",
  supPage.status === 200 && /text\/html/.test(supPage.ct) && /Support aprscaching/.test(supPage.body),
);

// ---- logging finds by radio message: FOUND / DNF to the service call ----
{
  const rc = "OE7RAD";
  const st = await call("POST", "/auth/email/start", { email: `radio+${now()}@example.test`, callsign: rc });
  const vr = await fetch(BASE + "/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: st.data?.devToken }),
  });
  const rcookie = (/(acs=[^;]+)/.exec(vr.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
  ok("radio: the sender's callsign verifies by an on-air VERIFY", await verifyCallsign(rc, rcookie));
  const code = created.data?.cache?.code;
  const msg = (text, extra) => ({
    src: `${rc}-7`,
    dst: "APRS",
    payload: `:APRSCG   :${text}`,
    kind: "message",
    ts: now(),
    ...extra,
  });
  // heard directly at the attested site OE8XXX → logged at once
  await call(
    "POST",
    "/ingest",
    {
      packets: [
        msg(`FOUND ${code} from the radio{7`, {
          path: ["WIDE1-1"],
          heardVia: "rf",
          igateCall: "OE8XXX",
          port: "kiss-tnc",
        }),
      ],
    },
    { "x-ingest-secret": SECRET },
  );
  // arrived over APRS-IS only → pending until confirmed in the app
  await call(
    "POST",
    "/ingest",
    { packets: [msg(`DNF ${code}{8`, { path: ["TCPIP*", "qAC", "T2TEST"], heardVia: "aprs_is", port: "aprs-is" })] },
    { "x-ingest-secret": SECRET },
  );
  const list = await call("GET", "/api/radio/commands", undefined, { cookie: rcookie });
  const cmds = list.data?.commands ?? [];
  const found = cmds.find((c) => c.command === "found");
  const dnf = cmds.find((c) => c.command === "dnf");
  ok("radio: FOUND heard at an attested site is logged", found?.status === "logged", JSON.stringify(list.data));
  ok("radio: DNF over APRS-IS waits for confirmation", dnf?.status === "pending", JSON.stringify(list.data));
  ok("radio: the list names the service call", list.data?.serviceCall === "APRSCG");
  const conf = await call("POST", `/api/radio/commands/${dnf?.id}/confirm`, {}, { cookie: rcookie });
  ok("radio: confirming the pending DNF logs it", conf.data?.status === "logged", JSON.stringify(conf.data));
  ok("radio: another session cannot see the commands", (await call("GET", "/api/radio/commands")).status === 401);
  const ob = await call("GET", "/outbox");
  const acks = (ob.data?.items ?? []).map((it) => it.payload);
  ok(
    "radio: both numbered messages are acked from the service call",
    acks.includes(`:${rc}-7 :ack7`) && acks.includes(`:${rc}-7 :ack8`),
    JSON.stringify(acks.slice(-5)),
  );
  const logsOf = await call("GET", `/api/caches/${id}`);
  ok("radio: the logbook carries the radio find", JSON.stringify(logsOf.data ?? {}).includes(`${rc}-7`));
}

console.log(failures ? `\nFAILED (${failures})` : "\nALL CONFORMANCE CHECKS PASSED");
process.exit(failures ? 1 : 0);
