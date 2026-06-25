// Two-instance federation conformance (F2): a PUBLISHER and a SUBSCRIBER, both already running.
// Seeds the publisher, triggers a pull-sync on the subscriber, and asserts the subscriber mirrored
// the publisher's (signature-verified) cache onto its own map.
//
//   PUB=http://127.0.0.1:8801 SUB=http://127.0.0.1:8802 node tools/smoke/federation.mjs

const PUB = process.env.PUB ?? "http://127.0.0.1:8801";
const SUB = process.env.SUB ?? "http://127.0.0.1:8802";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
const now = () => Math.floor(Date.now() / 1000);
let failures = 0;

function ok(name, cond, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
async function call(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method, headers: { "content-type": "application/json", "x-ingest-secret": SECRET, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function waitHealthy(base) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/health")).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

console.log(`federation: PUB=${PUB}  SUB=${SUB}`);
ok("publisher healthy", await waitHealthy(PUB));
ok("subscriber healthy", await waitHealthy(SUB));

// publisher must be signed (so the subscriber can verify what it mirrors)
const pubWk = await call(PUB, "GET", "/.well-known/aprscaching");
ok("publisher is signed", pubWk.data?.signed === true, JSON.stringify(pubWk.data));
const pubInstance = pubWk.data?.instance;

// seed the publisher: a cache + a verified find
const TITLE = "Federated Schlossberg " + now();
const created = await call(PUB, "POST", "/api/caches", {
  title: TITLE, type: "single", lat: 47.0735, lon: 15.4378, difficulty: 2, terrain: 2, ownerCall: "OE8APR",
});
ok("publisher created a cache", created.status === 201, JSON.stringify(created.data));
const pid = created.data?.cache?.id;
await call(PUB, "POST", `/api/caches/${pid}/logs`, {
  loggerCall: "DL1ABC", logType: "found", appGeo: { lat: 47.07355, lon: 15.43785, accuracyM: 11, ts: now() },
});

// trigger a pull-sync on the subscriber
const sync = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("subscriber sync ran", sync.data?.ok === true, JSON.stringify(sync.data));
ok("sync mirrored >= 1 cache", (sync.data?.caches ?? 0) >= 1, JSON.stringify(sync.data));
ok("sync mirrored >= 1 find", (sync.data?.finds ?? 0) >= 1, JSON.stringify(sync.data));
ok("sync had no peer errors", (sync.data?.errors ?? []).length === 0, JSON.stringify(sync.data?.errors));

// subscriber discovered + recorded the peer (signed)
const peers = await call(SUB, "GET", "/federation/peers");
ok("subscriber knows the peer (signed)", (peers.data?.peers ?? []).some((p) => p.instance === pubInstance && p.signed),
  JSON.stringify(peers.data));

// the publisher's cache now appears on the SUBSCRIBER's map, marked mirrored
const list = await call(SUB, "GET", "/api/caches?bbox=15,46,16,48");
const mirror = (list.data?.caches ?? []).find((c) => c.mirrored && c.title === TITLE);
ok("mirrored cache appears on subscriber map", !!mirror, `titles=${(list.data?.caches ?? []).map((c) => c.title)}`);
ok("mirrored cache carries origin + globalId, no local id",
  mirror?.origin === pubInstance && /:cache:/.test(mirror?.globalId ?? "") && mirror?.id === null,
  JSON.stringify(mirror));

// idempotency: a second sync should not error and the cache stays single
const sync2 = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("re-sync is clean", sync2.data?.ok === true && (sync2.data?.errors ?? []).length === 0);
const list2 = await call(SUB, "GET", "/api/caches?bbox=15,46,16,48");
ok("no duplicate mirror after re-sync",
  (list2.data?.caches ?? []).filter((c) => c.title === TITLE).length === 1);

// auth: sync requires the ingest secret (the call() default is overridden with an invalid one)
const noauth = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": "" });
ok("sync with an invalid secret -> 401", noauth.status === 401, `status=${noauth.status}`);

// ---- F3: cross-instance verification (the network effect) ----
// The logger's RF position is heard only by the PUBLISHER's IGate (independent of the logger).
// The cache + the find live on the SUBSCRIBER, which has NO local RF fix — it must reach Tier A
// by querying the publisher's corroboration pool.
const LAT = 47.2, LON = 15.05, t = now();
await call(PUB, "POST", "/ingest", {
  packets: [{
    src: "LO3RF", path: ["WIDE1-1", "qAR", "OE8XXX"], payload: "=4712.00N/01503.00E>",
    kind: "position", parsed: { lat: LAT + 0.0005, lon: LON, symbol: ">" },
    heardVia: "rf", igateCall: "OE8XXX", port: "aprs-is", ts: t,
  }],
}, { "x-ingest-secret": SECRET });

const sCache = await call(SUB, "POST", "/api/caches", {
  title: "Peer-Verified Summit " + t, type: "single", lat: LAT, lon: LON, ownerCall: "OE8SUB",
});
const sid = sCache.data?.cache?.id;
ok("subscriber created its own cache", sCache.status === 201, JSON.stringify(sCache.data));

// no appGeo, no local RF on the subscriber -> only peer corroboration can grant Tier A
const peerLog = await call(SUB, "POST", `/api/caches/${sid}/logs`, { loggerCall: "LO3RF", logType: "found" });
ok("subscriber reaches Tier A via peer corroboration",
  peerLog.data?.verified === true && peerLog.data?.tier === "A" && peerLog.data?.method === "aprs_rf_peer",
  JSON.stringify(peerLog.data));
ok("corroboration is attributed to the publisher instance", peerLog.data?.corroboratedBy === pubInstance,
  JSON.stringify(peerLog.data?.corroboratedBy));

// a logger nobody heard stays unverified (no false corroboration)
const ghost = await call(SUB, "POST", `/api/caches/${sid}/logs`, { loggerCall: "GHOST9", logType: "found" });
ok("an un-heard logger does NOT reach Tier A", ghost.data?.tier !== "A", JSON.stringify(ghost.data));

// ---- F0: per-callsign signing ----
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
const authMsg = (a) => stableStringify({ v: 1, cache: a.cache, instance: a.instance, logger: a.logger, logType: a.logType, at: a.at });
const b64u = (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const ub64 = (s) => { const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/")); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };
const signWith = async (priv, msg) => b64u(await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)));

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubRaw = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));

const reg = await call(PUB, "POST", "/keys/register", { callsign: "OE8APR", publicKey: pubRaw, label: "device" });
ok("key registration accepted", reg.data?.ok === true && reg.data?.publicKey === pubRaw, JSON.stringify(reg.data));

const sc = await call(PUB, "POST", "/api/caches", { title: "Signed Find " + now(), type: "single", lat: 47.08, lon: 15.41, ownerCall: "OE8APR" });
const scCode = sc.data?.cache?.code, scId = sc.data?.cache?.id;
const at = now();
const sig = await signWith(kp.privateKey, authMsg({ cache: scCode, instance: pubInstance, logger: "OE8APR", logType: "found", at }));
const signedLog = await call(PUB, "POST", `/api/caches/${scId}/logs`, { loggerCall: "OE8APR", logType: "found", author: { authorKey: pubRaw, authorSig: sig, signedAt: at } });
ok("signed find accepted; signerKey echoed", signedLog.data?.logged === true && signedLog.data?.signerKey === pubRaw, JSON.stringify(signedLog.data));

// flip the first (fully-significant) base64url char so the signature is guaranteed to differ
const badSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
const bad = await call(PUB, "POST", `/api/caches/${scId}/logs`, { loggerCall: "OE8APR", logType: "found", author: { authorKey: pubRaw, authorSig: badSig, signedAt: at } });
ok("tampered author signature -> 400", bad.status === 400, `status=${bad.status}`);

const kp2 = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub2 = b64u(await crypto.subtle.exportKey("raw", kp2.publicKey));
const at2 = now();
const sig2 = await signWith(kp2.privateKey, authMsg({ cache: scCode, instance: pubInstance, logger: "OE8APR", logType: "found", at: at2 }));
const unreg = await call(PUB, "POST", `/api/caches/${scId}/logs`, { loggerCall: "OE8APR", logType: "found", author: { authorKey: pub2, authorSig: sig2, signedAt: at2 } });
ok("unregistered key -> 400", unreg.status === 400, `status=${unreg.status}`);

// verify the author signature straight from the federation feed, as any consumer would
const finds = await call(PUB, "GET", "/federation/finds?since=0&limit=1000");
const frec = (finds.data?.items ?? []).find((r) => r.data?.loggerCall === "OE8APR" && r.data?.authorKey === pubRaw && r.data?.cacheCode === scCode);
ok("finds feed carries the author signature", !!frec);
let authorOk = false;
if (frec) {
  const key = await crypto.subtle.importKey("raw", ub64(frec.data.authorKey), { name: "Ed25519" }, false, ["verify"]);
  const msg = new TextEncoder().encode(authMsg({ cache: frec.data.cacheCode, instance: pubInstance, logger: frec.data.loggerCall, logType: frec.data.logType, at: frec.data.signedAt }));
  authorOk = await crypto.subtle.verify("Ed25519", key, ub64(frec.data.authorSig), msg);
}
ok("author signature verifies from the feed (per-callsign provenance)", authorOk);

const keysFeed = await call(PUB, "GET", "/federation/keys?since=0&limit=500");
ok("keys feed publishes the callsign->key binding",
  (keysFeed.data?.items ?? []).some((r) => r.data?.callsign === "OE8APR" && r.data?.publicKey === pubRaw));

const syncK = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("subscriber mirrors keys", (syncK.data?.keys ?? 0) >= 1, JSON.stringify(syncK.data));
const peers2 = await call(SUB, "GET", "/federation/peers");
ok("subscriber keys_cursor advanced", (peers2.data?.peers ?? []).some((p) => p.instance === pubInstance && p.keys_cursor > 0), JSON.stringify(peers2.data));

console.log(failures ? `\nFEDERATION FAILED (${failures})` : "\nFEDERATION CONFORMANCE PASSED");
process.exit(failures ? 1 : 0);
