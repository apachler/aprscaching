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
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
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

// owner gating + auth guards
const wrongOwner = await call("PATCH", `/api/caches/${id}`, { ownerCall: "DL9NO", difficulty: 5 });
ok("non-owner edit -> 403", wrongOwner.status === 403, `status=${wrongOwner.status}`);
const badSecret = await call("POST", "/ingest", { packets: [] }, { "x-ingest-secret": "wrong" });
ok("bad ingest secret -> 401", badSecret.status === 401, `status=${badSecret.status}`);
const missing = await call("GET", "/api/caches/999999");
ok("unknown cache -> 404", missing.status === 404, `status=${missing.status}`);

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
const lb = await call("GET", "/api/leaderboard?metric=finds");
ok("leaderboard ranks loggers", (lb.data?.leaderboard ?? []).some((e) => e.loggerCall === "DL1ABC" && e.finds >= 1), JSON.stringify(lb.data));
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

console.log(failures ? `\nFAILED (${failures})` : "\nALL CONFORMANCE CHECKS PASSED");
process.exit(failures ? 1 : 0);
