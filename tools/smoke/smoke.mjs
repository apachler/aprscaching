// Runtime-agnostic conformance smoke test for the aprscaching gateway.
// Runs the same end-to-end flow against ANY base URL (Cloudflare Worker or Node/SQLite),
// so CI can prove the two runtimes behave identically. Exits non-zero on the first failure.
//
//   BASE=http://127.0.0.1:8787 node tools/smoke/smoke.mjs

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
const now = () => Math.floor(Date.now() / 1000);
let failures = 0;

function ok(name, cond, detail = "") {
  const pass = !!cond;
  console.log(`${pass ? "✓" : "✗"} ${name}${pass ? "" : `  — ${detail}`}`);
  if (!pass) failures++;
}

async function call(method, path, body, headers = {}) {
  // The smoke acts as the trusted backend (it holds INGEST_SECRET), so writes that attribute an
  // arbitrary RF/heard callsign go through the ingest-authorised path. Explicit headers still win
  // (e.g. the bad-secret rejection tests). Web session gating is checked separately below.
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", "x-ingest-secret": SECRET, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

console.log(`smoke: ${BASE}`);
ok("health", await waitHealthy());

// ---- M9 auth: email magic-link register -> session (the headless-exercisable path) ----
{
  const email = `smoke+${now()}@example.test`;
  const callsign = `OE${now() % 1000}X`;
  const start = await call("POST", "/auth/email/start", { email, callsign });
  ok("auth: email/start -> devToken (dev mode)", start.status === 200 && !!start.data?.devToken,
    `status=${start.status} ${JSON.stringify(start.data)}`);
  const vr = await fetch(BASE + "/auth/email/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: start.data?.devToken }),
  });
  const vd = await vr.json().catch(() => ({}));
  const cookie = (/(acs=[^;]+)/.exec(vr.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
  ok("auth: email/verify -> session cookie + callsign", vr.status === 200 && vd.callsign === callsign && cookie.startsWith("acs="),
    `status=${vr.status} cookie=${cookie} ${JSON.stringify(vd)}`);
  const sess = await call("GET", "/auth/session", undefined, { cookie });
  ok("auth: session -> signed-in callsign", sess.data?.callsign === callsign, JSON.stringify(sess.data));
}

// hide a cache
const created = await call("POST", "/api/caches", {
  title: "Smoke Cache", type: "single", lat: 47.0735, lon: 15.4378,
  difficulty: 1.5, terrain: 2, ownerCall: "OE8APR", hint: "behind the clock",
});
ok("create -> 201 + AC code", created.status === 201 && /^AC-\d+/.test(created.data?.cache?.code ?? ""),
  `status=${created.status} ${JSON.stringify(created.data)}`);
const id = created.data?.cache?.id;

// list in bbox
const list = await call("GET", "/api/caches?bbox=15,46,16,48");
ok("list includes the new cache", (list.data?.caches ?? []).some((c) => c.id === id));

// Tier B — in-app geolocation near the cache
const tb = await call("POST", `/api/caches/${id}/logs`, {
  loggerCall: "DL1ABC", logType: "found",
  appGeo: { lat: 47.07355, lon: 15.43785, accuracyM: 11, ts: now() },
});
ok("Tier B verified (app_geo)", tb.data?.verified === true && tb.data?.tier === "B", JSON.stringify(tb.data));

// Tier A — RF-heard, independently gated position then a found log
const ing = await call("POST", "/ingest", {
  packets: [{
    src: "OE3RF", path: ["WIDE1-1", "qAR", "OE8XXX"], payload: "=4704.41N/01526.27E>",
    kind: "position", parsed: { lat: 47.0734, lon: 15.4377, symbol: ">" },
    heardVia: "rf", igateCall: "OE8XXX", port: "aprs-is", ts: now(),
  }],
}, { "x-ingest-secret": SECRET });
ok("ingest stores 1 position", ing.data?.ok === true && ing.data?.stored === 1, JSON.stringify(ing.data));
const ta = await call("POST", `/api/caches/${id}/logs`, { loggerCall: "OE3RF", logType: "found" });
ok("Tier A verified (aprs_rf)", ta.data?.verified === true && ta.data?.tier === "A", JSON.stringify(ta.data));

// DNF — recorded, never verified
const dnf = await call("POST", `/api/caches/${id}/logs`, { loggerCall: "OE5XYZ", logType: "dnf" });
ok("DNF logged, unverified", dnf.data?.logged === true && dnf.data?.verified === false, JSON.stringify(dnf.data));

// --- S4: web logging/hiding is gated behind a session (the over-APRS path stays open via secret) ---
const noAuthLog = await fetch(`${BASE}/api/caches/${id}/logs`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ loggerCall: "NOSESS", logType: "found" }),
});
ok("web log without a session is rejected (401)", noAuthLog.status === 401, `status=${noAuthLog.status}`);
const noAuthHide = await fetch(`${BASE}/api/caches`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "x", type: "single", lat: 47, lon: 15, ownerCall: "NOSESS" }),
});
ok("web hide without a session is rejected (401)", noAuthHide.status === 401, `status=${noAuthHide.status}`);
// the genuine web path: register via email magic-link -> session cookie -> log attributed to it
// (on its own cache, so the find count of the shared `id` cache is left untouched)
const SESSCALL = "OE9SESS";
const eStart = await call("POST", "/auth/email/start", { email: `s${now()}@example.com`, callsign: SESSCALL });
const eVer = await fetch(`${BASE}/auth/email/verify?token=${eStart.data.devToken}`, { headers: { accept: "application/json" } });
const cookie = (eVer.headers.get("set-cookie") ?? "").split(";")[0];
const sCache = await call("POST", "/api/caches", { title: "Session Find " + now(), type: "single", lat: 47.2, lon: 15.6, ownerCall: "OE8APR" });
const sCacheId = sCache.data?.cache?.id;
const sessLog = await fetch(`${BASE}/api/caches/${sCacheId}/logs`, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ logType: "found" }),   // no loggerCall: the session attributes it
});
const sessLogBody = await sessLog.json().catch(() => ({}));
ok("session (email) log succeeds", sessLog.status === 200 && sessLogBody.logged === true, `status=${sessLog.status} ${JSON.stringify(sessLogBody)}`);
const sessDetail = await call("GET", `/api/caches/${sCacheId}`);
ok("the session find is attributed to the signed-in callsign", (sessDetail.data?.cache?.logs ?? []).some((l) => l.loggerCall === SESSCALL), JSON.stringify((sessDetail.data?.cache?.logs ?? []).map((l) => l.loggerCall)));

// S5: change the active callsign — re-binds the session and resets verification to pending
const chg = await fetch(`${BASE}/auth/callsign`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ callsign: "OE9CHG" }) });
const chgBody = await chg.json().catch(() => ({}));
const cookie2 = (chg.headers.get("set-cookie") ?? "").split(";")[0] || cookie;
ok("change callsign succeeds + re-binds the session", chg.status === 200 && chgBody.callsign === "OE9CHG", `status=${chg.status} ${JSON.stringify(chgBody)}`);
const who = await fetch(`${BASE}/auth/session`, { headers: { cookie: cookie2 } });
const whoBody = await who.json().catch(() => ({}));
ok("session reports the new callsign, unverified", whoBody.callsign === "OE9CHG" && whoBody.verified === false, JSON.stringify(whoBody));
const chgSame = await fetch(`${BASE}/auth/callsign`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie2 }, body: JSON.stringify({ callsign: "OE9CHG" }) });
ok("changing to your current callsign -> 400", chgSame.status === 400, `status=${chgSame.status}`);

// --- multiple verified base calls per account (account_callsigns) ---
// the account now holds OE9SESS (primary, from email register) + OE9CHG (switched-to). Verify the
// active call, switch away to the primary, switch BACK, and confirm verification is preserved —
// switching among held calls must never re-challenge.
const mcList1 = await (await fetch(`${BASE}/auth/callsigns`, { headers: { cookie: cookie2 } })).json();
const mcCalls1 = mcList1.callsigns ?? [];
ok("account holds its primary + the switched-to call", mcCalls1.some((c) => c.callsign === "OE9SESS" && c.isPrimary) && mcCalls1.some((c) => c.callsign === "OE9CHG" && c.active), JSON.stringify(mcList1));
ok("active callsign verifies over APRS", await verifyCallsign("OE9CHG"));
const whoV = await (await fetch(`${BASE}/auth/session`, { headers: { cookie: cookie2 } })).json();
ok("session reports the active callsign as verified", whoV.callsign === "OE9CHG" && whoV.verified === true, JSON.stringify(whoV));
const toPrimary = await fetch(`${BASE}/auth/callsign`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie2 }, body: JSON.stringify({ callsign: "OE9SESS" }) });
const cookieP = (toPrimary.headers.get("set-cookie") ?? "").split(";")[0] || cookie2;
const whoP = await (await fetch(`${BASE}/auth/session`, { headers: { cookie: cookieP } })).json();
ok("switching to the unverified primary reports it unverified (per-call state)", whoP.callsign === "OE9SESS" && whoP.verified === false, JSON.stringify(whoP));
const back = await fetch(`${BASE}/auth/callsign`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieP }, body: JSON.stringify({ callsign: "OE9CHG" }) });
const backBody = await back.json().catch(() => ({}));
const cookieB = (back.headers.get("set-cookie") ?? "").split(";")[0] || cookieP;
ok("switching back to a held verified call preserves verification (no re-challenge)", backBody.verified === true, JSON.stringify(backBody));
const whoB = await (await fetch(`${BASE}/auth/session`, { headers: { cookie: cookieB } })).json();
ok("session confirms the restored verification", whoB.callsign === "OE9CHG" && whoB.verified === true, JSON.stringify(whoB));
// add a brand-new base call (held + unverified; SSID is stripped; active call unchanged)
const add = await fetch(`${BASE}/auth/callsigns`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieB }, body: JSON.stringify({ callsign: "OE9ADD-7" }) });
const addBody = await add.json().catch(() => ({}));
ok("adding a base call holds it unverified without switching", add.status === 200 && addBody.callsign === "OE9ADD" && addBody.verified === false, `status=${add.status} ${JSON.stringify(addBody)}`);
const mcList2 = await (await fetch(`${BASE}/auth/callsigns`, { headers: { cookie: cookieB } })).json();
ok("the added call joins the held set; active is unchanged", (mcList2.callsigns ?? []).some((c) => c.callsign === "OE9ADD") && mcList2.active === "OE9CHG", JSON.stringify(mcList2));
const addDup = await fetch(`${BASE}/auth/callsigns`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieB }, body: JSON.stringify({ callsign: "OE9ADD" }) });
ok("adding a call you already hold -> 409", addDup.status === 409, `status=${addDup.status}`);
// a base call held by ANOTHER account is off-limits (both add and switch are rejected)
const otherStart = await call("POST", "/auth/email/start", { email: `o${now()}@example.com`, callsign: "OE2OTHER" });
await fetch(`${BASE}/auth/email/verify?token=${otherStart.data.devToken}`, { headers: { accept: "application/json" } });
const addOther = await fetch(`${BASE}/auth/callsigns`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieB }, body: JSON.stringify({ callsign: "OE2OTHER" }) });
ok("adding a call held by another account -> 409", addOther.status === 409, `status=${addOther.status}`);
const switchOther = await fetch(`${BASE}/auth/callsign`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieB }, body: JSON.stringify({ callsign: "OE2OTHER" }) });
ok("switching to a call held by another account -> 409", switchOther.status === 409, `status=${switchOther.status}`);

// owner gating + auth guards
const wrongOwner = await call("PATCH", `/api/caches/${id}`, { ownerCall: "DL9NO", difficulty: 5 });
ok("non-owner edit -> 403", wrongOwner.status === 403, `status=${wrongOwner.status}`);
const badSecret = await call("POST", "/ingest", { packets: [] }, { "x-ingest-secret": "wrong" });
ok("bad ingest secret -> 401", badSecret.status === 401, `status=${badSecret.status}`);
const missing = await call("GET", "/api/caches/999999");
ok("unknown cache -> 404", missing.status === 404, `status=${missing.status}`);

// AGPL §13 source link (ADR-3) — every instance exposes its running source
const srcDesc = await call("GET", "/.well-known/source");
ok("AGPL §13 source descriptor (repo + AGPL licence)", /github\.com/.test(srcDesc.data?.repo ?? "") && srcDesc.data?.license === "AGPL-3.0-or-later", JSON.stringify(srcDesc.data));
const srcRedir = await fetch(`${BASE}/source`, { redirect: "manual" });
ok("/source 302-redirects to the repo", srcRedir.status === 302 && /github\.com/.test(srcRedir.headers.get("location") ?? ""), `status=${srcRedir.status} loc=${srcRedir.headers.get("location")}`);

// detail: 2 verified finds + a 4-entry-less logbook (3 logs here)
const detail = await call("GET", `/api/caches/${id}`);
ok("detail: 2 verified finds", detail.data?.cache?.finds === 2, JSON.stringify(detail.data?.cache?.finds));
ok("detail: logbook has 3 entries", (detail.data?.cache?.logs ?? []).length === 3,
  `len=${(detail.data?.cache?.logs ?? []).length}`);

// ---- federation (F1): discovery + signed, mirrorable feeds ----
const wk = await call("GET", "/.well-known/aprscaching");
ok("well-known descriptor", (wk.data?.protocol ?? "").startsWith("aprscaching-federation"), JSON.stringify(wk.data));
const fc = await call("GET", "/federation/caches?since=0&limit=500");
ok("caches feed has records",
  Array.isArray(fc.data?.items) && fc.data.items.some((r) => typeof r.id === "string" && r.id.includes(":cache:")),
  `count=${fc.data?.count}`);
const ff = await call("GET", "/federation/finds?since=0&limit=500");
ok("finds feed has >= 2 records", (ff.data?.items?.length ?? 0) >= 2, `count=${ff.data?.count}`);
const ff2 = await call("GET", `/federation/finds?since=${ff.data?.nextCursor ?? 0}`);
ok("finds cursor advances (empty past nextCursor)", (ff2.data?.items?.length ?? 0) === 0);

if (wk.data?.signed) {
  const rec = (fc.data?.items ?? [])[0];
  ok("signed cache record verifies against published key", rec ? await verifyRecord(wk.data.publicKeyJwk, rec) : false);
} else {
  console.log("• federation unsigned (no FED_PRIVATE_KEY) — signature check skipped");
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
function b64urlToBytes(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function verifyRecord(pubJwk, rec) {
  try {
    const key = await crypto.subtle.importKey("jwk", pubJwk, { name: "Ed25519" }, false, ["verify"]);
    const msg = new TextEncoder().encode(stableStringify({ type: rec.type, id: rec.id, data: rec.data }));
    return await crypto.subtle.verify("Ed25519", key, b64urlToBytes(rec.sig), msg);
  } catch { return false; }
}

// ---- F0: per-callsign signing (single instance, exercised on both runtimes) ----
const b64u = (buf) => { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubRaw = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
const reg = await call("POST", "/keys/register", { callsign: "DL1ABC", publicKey: pubRaw });
ok("key registration accepted", reg.data?.ok === true, JSON.stringify(reg.data));

const at = now();
const amsg = stableStringify({ v: 1, cache: created.data?.cache?.code, instance: wk.data?.instance, logger: "DL1ABC", logType: "found", at });
const sig = b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(amsg)));
const signed = await call("POST", `/api/caches/${id}/logs`, { loggerCall: "DL1ABC", logType: "found", author: { authorKey: pubRaw, authorSig: sig, signedAt: at } });
ok("signed find accepted; signerKey echoed", signed.data?.logged === true && signed.data?.signerKey === pubRaw, JSON.stringify(signed.data));
// flip the first (fully-significant) base64url char so the signature is guaranteed to differ
const badSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
const tampered = await call("POST", `/api/caches/${id}/logs`, { loggerCall: "DL1ABC", logType: "found", author: { authorKey: pubRaw, authorSig: badSig, signedAt: at } });
ok("tampered author signature -> 400", tampered.status === 400, `status=${tampered.status}`);

// ---- M4: community / gamification ----
// leaderboard credit now requires a control-verified callsign — an unverified logger is excluded
const lbPre = await call("GET", "/api/leaderboard?metric=finds");
ok("unverified callsign earns no leaderboard credit", !(lbPre.data?.leaderboard ?? []).some((e) => e.loggerCall === "DL1ABC"), JSON.stringify(lbPre.data));
// control-verify DL1ABC the real way: start the APRS challenge, read the code off the outbox, confirm
async function verifyCallsign(cs) {
  await call("POST", "/verify/aprs/start", { callsign: cs });
  const ob = await call("GET", "/outbox");
  const m = (ob.data?.items ?? []).find((it) => (it.payload || "").includes(cs) && /code\s+\d{6}/.test(it.payload || ""));
  const code = m && (m.payload.match(/code\s+(\d{6})/) || [])[1];
  const conf = await call("POST", "/verify/aprs/confirm", { callsign: cs, code });
  return conf.data?.verified === true;
}
ok("APRS message-challenge verifies the callsign (start → read code → confirm)", await verifyCallsign("DL1ABC"));
const lb = await call("GET", "/api/leaderboard?metric=finds");
ok("a verified callsign now ranks on the leaderboard", (lb.data?.leaderboard ?? []).some((e) => e.loggerCall === "DL1ABC" && e.finds >= 1), JSON.stringify(lb.data));
const prof = await call("GET", "/api/profile/DL1ABC");
ok("profile shows verified finds + points", (prof.data?.finds ?? 0) >= 1 && (prof.data?.points ?? 0) > 0, JSON.stringify(prof.data));
ok("profile awards a find badge", (prof.data?.badges ?? []).some((b) => b.badge === "first-find"), JSON.stringify(prof.data?.badges));
const favOn = await call("POST", `/api/caches/${id}/favorite`, { callsign: "DL1ABC", on: true });
ok("favorite toggled on", favOn.data?.on === true && (favOn.data?.count ?? 0) >= 1, JSON.stringify(favOn.data));
const det = await call("GET", `/api/caches/${id}?callsign=DL1ABC`);
ok("detail carries favorite + health fields", det.data?.cache?.favorited === true && typeof det.data?.cache?.needsMaintenance === "boolean", JSON.stringify({ favorited: det.data?.cache?.favorited, nm: det.data?.cache?.needsMaintenance }));
const act = await call("GET", "/api/activity?limit=10");
ok("activity feed returns recent logs", Array.isArray(act.data?.activity) && act.data.activity.length >= 1, JSON.stringify(act.data?.activity?.length));

// ---- M5: workbench — packet inspector + live station registry ----
const dec = await call("POST", "/api/decode", { raw: "OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.00N/01526.00E>088/036Going home" });
ok("decode parses an uncompressed position", dec.data?.ok === true && dec.data?.data?.kind === "position" && Math.abs((dec.data?.data?.lat ?? 0) - 47.0667) < 0.01, JSON.stringify(dec.data?.data));
ok("decode classifies the q-construct (rf)", dec.data?.frame?.heardVia === "rf" && dec.data?.frame?.igateCall === "OE8XXX", JSON.stringify(dec.data?.frame));
const decBad = await call("POST", "/api/decode", { raw: "not a frame" });
ok("decode rejects a non-frame -> 400", decBad.status === 400, `status=${decBad.status}`);

// ingest a moving station + a weather station, then read them back from the registry
const wbIngest = await call("POST", "/ingest", {
  packets: [
    { src: "OE1MOB-9", dst: "APRS", path: ["WIDE1-1", "qAR", "OE8XXX"], payload: "!4704.00N/01526.00E>088/036", kind: "position", heardVia: "rf", igateCall: "OE8XXX", port: "aprs-is", ts: now() },
    { src: "OE1WX", dst: "APRS", path: ["TCPIP*", "qAC", "T2"], payload: "!4705.00N/01527.00E_220/004g005t077r000p000P000h50b09900", kind: "weather", heardVia: "aprs_is", port: "aprs-is", ts: now() },
  ],
}, { "x-ingest-secret": SECRET });
ok("ingest stores 2 enriched stations", wbIngest.data?.ok === true && wbIngest.data?.stored === 2, JSON.stringify(wbIngest.data));

const stations = await call("GET", "/api/stations?bbox=15,46,16,48");
const mob = (stations.data?.stations ?? []).find((s) => s.callsign === "OE1MOB-9");
ok("station registry returns the moving station with course + symbol", mob && mob.course === 88 && mob.symbol === "/>", JSON.stringify(mob));

const stDetail = await call("GET", "/api/stations/OE1MOB-9");
ok("station detail carries a track", (stDetail.data?.station?.track ?? []).length >= 1 && stDetail.data?.station?.packets >= 1, JSON.stringify(stDetail.data?.station?.track?.length));

const wxDetail = await call("GET", "/api/stations/OE1WX");
ok("weather station detail carries a wx reading", wxDetail.data?.station?.wx && Math.abs((wxDetail.data?.station?.wx?.tempC ?? 0) - 25) < 1, JSON.stringify(wxDetail.data?.station?.wx));

// ---- M6: interop (CoT/TAK bridge) + transports + messaging ----
const msgIngest = await call("POST", "/ingest", {
  packets: [
    { src: "OE1MOB-9", dst: "APRS", path: ["TCPIP*", "qAC", "T2"], payload: ":OE8APR   :Hello from the field{007", kind: "message", heardVia: "aprs_is", port: "aprs-is", ts: now() },
    { src: "OE5KISS", dst: "APRS", path: ["WIDE1-1"], payload: "!4704.50N/01526.50E-KISS TNC node", kind: "position", heardVia: "rf", port: "kiss-tnc", ts: now() },
  ],
}, { "x-ingest-secret": SECRET });
ok("ingest accepts a 2nd-transport batch", msgIngest.data?.ok === true, JSON.stringify(msgIngest.data));

const cot = await call("GET", "/api/cot?bbox=15,46,16,48");
const cotXml = typeof cot.data === "string" ? cot.data : "";
const cotRaw = cotXml || (await (await fetch(BASE + "/api/cot?bbox=15,46,16,48")).text());
ok("CoT export is XML with a station event", /<events>/.test(cotRaw) && cotRaw.includes('uid="APRS.OE1MOB-9"') && /type="a-f-/.test(cotRaw), cotRaw.slice(0, 160));

const ports = await call("GET", "/api/ports");
const portList = ports.data?.ports ?? [];
ok("transports registry counts RX per port", portList.some((p) => p.port === "aprs-is" && p.rx >= 1) && portList.some((p) => p.port === "kiss-tnc"), JSON.stringify(portList));

const msgs = await call("GET", "/api/messages?to=OE8APR");
ok("messages feed returns the RX message", (msgs.data?.messages ?? []).some((mm) => mm.fromCall === "OE1MOB-9" && /Hello from the field/.test(mm.body)), JSON.stringify(msgs.data?.messages?.[0]));

// embeddable network badge (SVG, for QRZ.com etc.)
const badgeRes = await fetch(BASE + "/badge/OE8APR.svg");
const badgeSvg = await badgeRes.text();
ok("badge renders SVG with the callsign + finds", badgeRes.headers.get("content-type")?.includes("image/svg+xml") && /<svg/.test(badgeSvg) && badgeSvg.includes("OE8APR") && /finds/.test(badgeSvg), badgeSvg.slice(0, 80));

// ---- M2 audio-cache: staged multi-cache + media ----
const multi = await call("POST", "/api/caches", { title: "Staged Hunt", type: "multi", lat: 47.10, lon: 15.50, difficulty: 3, terrain: 3, ownerCall: "OE8APR" });
const mid = multi.data?.cache?.id;
const setStages = await call("POST", `/api/caches/${mid}/stages`, {
  ownerCall: "OE8APR",
  stages: [
    { stageNo: 0, lat: 47.10, lon: 15.50, radiusM: 60 },
    { stageNo: 1, unlock: "geo", clue: "listen to the clue, then walk north", lat: 47.11, lon: 15.51, radiusM: 60 },
    { stageNo: 2, unlock: "open", clue: "the final cache", lat: 47.12, lon: 15.52 },
  ],
});
ok("owner sets stages", setStages.data?.ok === true && setStages.data?.stages === 3, JSON.stringify(setStages.data));
const notOwner = await call("POST", `/api/caches/${mid}/stages`, { ownerCall: "DL9NO", stages: [] });
ok("non-owner cannot set stages -> 403", notOwner.status === 403, `status=${notOwner.status}`);

// upload an audio clue to stage 1 (raw audio body)
const upRes = await fetch(`${BASE}/api/caches/${mid}/stages/1/media`, { method: "PUT", headers: { "content-type": "audio/mpeg", "x-owner-call": "OE8APR", "x-ingest-secret": SECRET }, body: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]) });
const upJson = await upRes.json().catch(() => ({}));
ok("owner uploads an audio clue", upRes.status === 200 && typeof upJson.mediaKey === "string", JSON.stringify(upJson));
const mediaRes = await fetch(`${BASE}/api/media/${upJson.mediaKey}`);
ok("media clue served back as audio", mediaRes.status === 200 && (mediaRes.headers.get("content-type") || "").includes("audio/"), `status=${mediaRes.status}`);

// a finder sees stage 0 coords + the clue, but stage 1/2 coords are hidden
const stagesView = await call("GET", `/api/caches/${mid}/stages?callsign=DL1ABC`);
const sv = stagesView.data?.stages ?? [];
ok("stage 0 visible, later stages hidden until unlocked", sv[0]?.lat === 47.10 && sv[1]?.lat === null && sv[1]?.mediaUrl && sv[2]?.lat === null, JSON.stringify(sv.map((s) => ({ n: s.stageNo, lat: s.lat }))));

// unlock stage 1: too far -> 403, then within the stage-0 radius -> revealed
const tooFar = await call("POST", `/api/caches/${mid}/stages/1/unlock`, { callsign: "DL1ABC", appGeo: { lat: 47.30, lon: 15.50 } });
ok("unlock rejected when too far", tooFar.status === 403 && tooFar.data?.reason === "too_far", JSON.stringify(tooFar.data));
const unlock1 = await call("POST", `/api/caches/${mid}/stages/1/unlock`, { callsign: "DL1ABC", appGeo: { lat: 47.1001, lon: 15.5001 } });
ok("unlock at the previous stage reveals coords", unlock1.data?.unlocked === true && Math.abs((unlock1.data?.lat ?? 0) - 47.11) < 0.001, JSON.stringify(unlock1.data));
const unlock2 = await call("POST", `/api/caches/${mid}/stages/2/unlock`, { callsign: "DL1ABC" });
ok("open final stage unlocks after reaching stage 1", unlock2.data?.unlocked === true && Math.abs((unlock2.data?.lat ?? 0) - 47.12) < 0.001, JSON.stringify(unlock2.data));

const mdetail = await call("GET", `/api/caches/${mid}`);
ok("detail reports stageCount", mdetail.data?.cache?.stageCount === 3, JSON.stringify(mdetail.data?.cache?.stageCount));

// ---- account data lifecycle: GDPR export/erasure + portability (signed by a registered key) ----
const accMsg = (action, cs, at) => stableStringify({ v: 1, action, callsign: cs.toUpperCase(), instance: wk.data?.instance, at });
const signAct = async (action, cs, at) => b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(accMsg(action, cs, at))));

const noAuth = await call("POST", "/api/account/DL1ABC/export", {});
ok("account export without a signed action -> 401", noAuth.status === 401, `status=${noAuth.status}`);

let aAt = now();
const exp = await call("POST", "/api/account/DL1ABC/export", { key: pubRaw, sig: await signAct("export", "DL1ABC", aAt), at: aAt });
ok("GDPR export returns the caller's data", exp.data?.callsign === "DL1ABC" && Array.isArray(exp.data?.keys) && exp.data.keys.length >= 1 && Array.isArray(exp.data?.logs), JSON.stringify({ keys: exp.data?.keys?.length, logs: exp.data?.logs?.length }));

// migration: import a fresh callsign from a (foreign) bundle, proven by a device-key assertion
const kp2 = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub2 = b64u(await crypto.subtle.exportKey("raw", kp2.publicKey));
const mAt = now();
const mSig = b64u(await crypto.subtle.sign("Ed25519", kp2.privateKey, new TextEncoder().encode(accMsg("migrate", "OE9NEW", mAt))));
const imp = await call("POST", "/api/account/import", {
  bundle: { v: 1, instance: "oe.source.example", callsign: "OE9NEW", verified: true, keys: [{ publicKey: pub2, label: "phone", verified: 1 }], at: mAt },
  assertion: { key: pub2, sig: mSig, at: mAt },
});
ok("account import claims the callsign + keys", imp.data?.ok === true && imp.data?.importedKeys === 1, JSON.stringify(imp.data));
const movedKeys = await call("GET", "/keys/OE9NEW");
ok("imported device key is present on the target", (movedKeys.data?.keys ?? []).some((k) => k.publicKey === pub2), JSON.stringify(movedKeys.data?.keys?.length));
const impDup = await call("POST", "/api/account/import", { bundle: { callsign: "OE9NEW", keys: [{ publicKey: pub2 }] }, assertion: { key: pub2, sig: mSig, at: mAt } });
ok("re-importing an existing callsign -> 409", impDup.status === 409, `status=${impDup.status}`);

// erasure: anonymise + remove DL1ABC, then confirm it's gone
aAt = now();
const del = await call("POST", "/api/account/DL1ABC/delete", { key: pubRaw, sig: await signAct("delete", "DL1ABC", aAt), at: aAt });
ok("GDPR erasure succeeds", del.data?.ok === true && del.data?.erased === "DL1ABC", JSON.stringify(del.data));
const goneKeys = await call("GET", "/keys/DL1ABC");
ok("erased account keys are removed", (goneKeys.data?.keys ?? []).length === 0, JSON.stringify(goneKeys.data?.keys?.length));
const goneProf = await call("GET", "/api/profile/DL1ABC");
ok("erased account finds are anonymised away", (goneProf.data?.finds ?? 0) === 0, JSON.stringify(goneProf.data?.finds));

// ---- BBS store-and-forward: hold personal mail, deliver when heard, confirm on ack ----
const bbsP = await call("POST", "/api/bbs/messages", { fromCall: "OE8APR", toCall: "OE7BBS", body: "meet at the summit cache" });
ok("BBS accepts a personal message", bbsP.status === 201 && bbsP.data?.type === "P" && bbsP.data?.id > 0, JSON.stringify(bbsP.data));
const msgId = bbsP.data?.id;
const bbsB = await call("POST", "/api/bbs/messages", { fromCall: "OE8APR", toCall: "ALL", body: "net tonight 8pm local" });
ok("BBS accepts a bulletin", bbsB.data?.type === "B", JSON.stringify(bbsB.data));

const list1 = await call("GET", "/api/bbs/messages?to=OE7BBS");
ok("personal mail starts held", (list1.data?.messages ?? []).some((mm) => mm.id === msgId && mm.delivery === "held"), JSON.stringify(list1.data?.messages?.[0]));

await call("POST", "/ingest", { packets: [{ src: "OE7BBS", dst: "APRS", path: ["TCPIP*", "qAC", "T2"], payload: "!4704.00N/01526.00E>", kind: "position", heardVia: "aprs_is", port: "aprs-is", ts: now() }] }, { "x-ingest-secret": SECRET });
const list2 = await call("GET", "/api/bbs/messages?to=OE7BBS");
ok("mail is forwarded when the station is heard", (list2.data?.messages ?? []).some((mm) => mm.id === msgId && mm.delivery === "sent" && mm.lineNo === msgId), JSON.stringify(list2.data?.messages?.[0]));

await call("POST", "/ingest", { packets: [{ src: "OE7BBS", dst: "APRS", path: ["TCPIP*", "qAC", "T2"], payload: `:APRSCG   :ack${msgId}`, kind: "message", heardVia: "aprs_is", port: "aprs-is", ts: now() }] }, { "x-ingest-secret": SECRET });
const list3 = await call("GET", "/api/bbs/messages?to=OE7BBS");
ok("ack confirms delivery", (list3.data?.messages ?? []).some((mm) => mm.id === msgId && mm.delivery === "acked"), JSON.stringify(list3.data?.messages?.[0]));

const bulls = await call("GET", "/api/bbs/bulletins");
ok("bulletin board lists the bulletin", (bulls.data?.bulletins ?? []).some((bb) => /net tonight/.test(bb.body) && bb.type === "B"), JSON.stringify(bulls.data?.bulletins?.length));

// ---- sitemap + RSS feeds: machine-readable site map and feeds over the public data ----
const text = async (path) => { const r = await fetch(BASE + path); return { status: r.status, ct: r.headers.get("content-type") ?? "", body: await r.text() }; };
const smap = await text("/sitemap.xml");
ok("sitemap.xml is XML with a urlset + ?view= deep-links", smap.status === 200 && /xml/.test(smap.ct) && smap.body.includes("<urlset") && smap.body.includes("?view=workbench"), `${smap.status} ${smap.ct}`);
const smapJson = await call("GET", "/api/sitemap");
ok("/api/sitemap lists surfaces + feeds with urls", (smapJson.data?.surfaces ?? []).length > 0 && (smapJson.data?.feeds ?? []).some((f) => f.url?.endsWith("/feeds/activity.xml")), JSON.stringify(smapJson.data?.feeds?.length));
const robots = await text("/robots.txt");
ok("robots.txt advertises the sitemap", robots.body.includes("Sitemap:") && robots.body.includes("/sitemap.xml"), robots.body.split("\n")[0]);

const actFeed = await text("/feeds/activity.xml");
ok("activity RSS has items for the seeded finds", /application\/rss\+xml/.test(actFeed.ct) && actFeed.body.includes("<rss") && actFeed.body.includes("<item>"), `${actFeed.status} ${actFeed.ct}`);
const cacheFeed = await text("/feeds/caches.xml");
ok("new-caches RSS lists a seeded cache", cacheFeed.body.includes("<rss") && /<item>/.test(cacheFeed.body), `${cacheFeed.status}`);
const bullFeed = await text("/feeds/bulletins.xml");
ok("bulletins RSS carries the bulletin", bullFeed.body.includes("net tonight"), `${bullFeed.status}`);
const lbFeed = await text("/feeds/leaderboard.xml");
ok("leaderboard RSS is a valid channel", lbFeed.body.includes("<rss") && lbFeed.body.includes("<channel>"), `${lbFeed.status}`);
const userFeed = await text("/feeds/u/OE8APR.xml");
ok("user RSS feed renders for a callsign", userFeed.body.includes("<rss") && userFeed.body.includes("OE8APR"), `${userFeed.status}`);

// ---- live activity spots (docs/20 S1): read-only, off by default, well-formed empty payload ----
const spots = await call("GET", "/api/spots?bbox=14,46,16,48&bands=20m");
ok("/api/spots responds with the spots envelope (disabled by default → empty)", spots.status === 200 && spots.data?.enabled === false && Array.isArray(spots.data?.spots) && spots.data.spots.length === 0, JSON.stringify(spots.data));

// ---- public read API (docs/11 §6, ADR-4a): versioned, rate-limited, free keys, read-only ----
const apiIdx = await call("GET", "/api/v1");
ok("/api/v1 index lists version + limits + endpoints", apiIdx.status === 200 && apiIdx.data?.version === "v1" && apiIdx.data?.rateLimits?.with_key > apiIdx.data?.rateLimits?.anonymous && Array.isArray(apiIdx.data?.endpoints), JSON.stringify(apiIdx.data?.rateLimits));
const apiKeyRes = await call("POST", "/api/v1/keys", { label: "smoke" });
const apiKey = apiKeyRes.data?.key;
ok("POST /api/v1/keys issues a free key", apiKeyRes.status === 201 && typeof apiKey === "string" && apiKey.startsWith("acg_"), JSON.stringify(apiKeyRes.data));
const v1caches = await call("GET", "/api/v1/caches?bbox=-180,-90,180,90", undefined, { authorization: "Bearer " + apiKey });
ok("GET /api/v1/caches (keyed) returns seeded caches", v1caches.status === 200 && (v1caches.data?.caches ?? []).length > 0, JSON.stringify(v1caches.data?.caches?.length));
const v1code = (v1caches.data?.caches ?? [])[0]?.code;
const v1detail = v1code ? await call("GET", "/api/v1/caches/" + v1code) : { status: 0, data: {} };
ok("GET /api/v1/caches/:code returns cache detail", v1detail.status === 200 && v1detail.data?.cache?.code === v1code, JSON.stringify({ v1code, got: v1detail.data?.cache?.code }));
const v1big = await call("GET", "/api/v1/caches?bbox=-60,-60,60,60");
ok("GET /api/v1 caps an oversized bbox (400)", v1big.status === 400, JSON.stringify(v1big.data));
const v1write = await call("POST", "/api/v1/caches", {});
ok("/api/v1 is read-only (write → 405)", v1write.status === 405, String(v1write.status));

console.log(failures ? `\nFAILED (${failures})` : "\nALL CONFORMANCE CHECKS PASSED");
process.exit(failures ? 1 : 0);
