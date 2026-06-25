// Two-instance federation conformance (F2): a PUBLISHER and a SUBSCRIBER, both already running.
// Seeds the publisher, triggers a pull-sync on the subscriber, and asserts the subscriber mirrored
// the publisher's (signature-verified) cache onto its own map.
//
//   PUB=http://127.0.0.1:8801 SUB=http://127.0.0.1:8802 node tools/smoke/federation.mjs

const PUB = process.env.PUB ?? "http://127.0.0.1:8801";
const SUB = process.env.SUB ?? "http://127.0.0.1:8802";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
const SUBMIT_SECRET = process.env.SUBMIT_SECRET ?? "submitsecret"; // SUB is started as a hub with this (T2.3)
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

// ---- F4/T1.1: peer trust tiers + quarantine ----
// The subscriber's only peer is the publisher, listed in FED_PEERS → it must be manual + trusted.
const pall = await call(SUB, "GET", "/federation/peers");
const peerRec = (pall.data?.peers ?? []).find((p) => p.instance === pubInstance) ?? {};
ok("manual peer is trusted + added_via=manual", peerRec.trust === "trusted" && peerRec.added_via === "manual", JSON.stringify(peerRec));

// operator control endpoint guards
const t401 = await call(SUB, "POST", "/federation/peers/trust", { url: PUB, trust: "blocked" }, { "x-ingest-secret": "" });
ok("trust change without the ingest secret -> 401", t401.status === 401, `status=${t401.status}`);
const t400 = await call(SUB, "POST", "/federation/peers/trust", { url: PUB, trust: "bogus" }, { "x-ingest-secret": SECRET });
ok("an invalid trust level -> 400", t400.status === 400, `status=${t400.status}`);
const t404 = await call(SUB, "POST", "/federation/peers/trust", { url: "http://127.0.0.1:9", trust: "trusted" }, { "x-ingest-secret": SECRET });
ok("an unknown peer -> 404", t404.status === 404, `status=${t404.status}`);

// quarantine: block the only peer → a fresh find can no longer reach Tier A (empty trusted pool)
const blk = await call(SUB, "POST", "/federation/peers/trust", { url: PUB, trust: "blocked" }, { "x-ingest-secret": SECRET });
ok("operator blocked the peer", blk.data?.ok === true && blk.data?.trust === "blocked", JSON.stringify(blk.data));
const bCache = await call(SUB, "POST", "/api/caches", { title: "Blocked-Peer Summit " + now(), type: "single", lat: LAT, lon: LON, ownerCall: "OE8SUB" });
const blockedLog = await call(SUB, "POST", `/api/caches/${bCache.data?.cache?.id}/logs`, { loggerCall: "LO3RF", logType: "found" });
ok("a blocked peer cannot grant Tier A", blockedLog.data?.tier !== "A", JSON.stringify(blockedLog.data));
const blkSync = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("a blocked peer is skipped on sync (no fetch, no error)", blkSync.data?.ok === true && (blkSync.data?.errors ?? []).length === 0, JSON.stringify(blkSync.data));

// promote back to trusted → corroboration is restored, and approval is stamped
const prom = await call(SUB, "POST", "/federation/peers/trust", { url: PUB, trust: "trusted" }, { "x-ingest-secret": SECRET });
ok("operator promoted the peer to trusted", prom.data?.ok === true && prom.data?.trust === "trusted", JSON.stringify(prom.data));
const rCache = await call(SUB, "POST", "/api/caches", { title: "Re-trusted Summit " + now(), type: "single", lat: LAT, lon: LON, ownerCall: "OE8SUB" });
const reLog = await call(SUB, "POST", `/api/caches/${rCache.data?.cache?.id}/logs`, { loggerCall: "LO3RF", logType: "found" });
ok("a re-trusted peer grants Tier A again", reLog.data?.tier === "A" && reLog.data?.method === "aprs_rf_peer", JSON.stringify(reLog.data));

// ---- F4/T1.3 + ADR-5: signed tombstones (GDPR delete propagation) ----
const accMsg = (action, cs, at) => stableStringify({ v: 1, action, callsign: cs.toUpperCase(), instance: pubInstance, at });
const tkp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const tpub = b64u(await crypto.subtle.exportKey("raw", tkp.publicKey));
await call(PUB, "POST", "/keys/register", { callsign: "TOMB1", publicKey: tpub, label: "device" });

// TOMB1 owns a cache and logs a find on the publisher
const T_TITLE = "Tombstone Cache " + now();
const tCache = await call(PUB, "POST", "/api/caches", { title: T_TITLE, type: "single", lat: 48.21, lon: 16.37, ownerCall: "TOMB1" });
await call(PUB, "POST", `/api/caches/${tCache.data?.cache?.id}/logs`, { loggerCall: "TOMB1", logType: "found" });
ok("publisher created a TOMB1-owned cache + find", tCache.status === 201, JSON.stringify(tCache.data));

// subscriber mirrors it onto its map
const BBOXT = "16.2,48.0,16.6,48.4";
await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
const mapBefore = await call(SUB, "GET", `/api/caches?bbox=${BBOXT}`);
ok("TOMB1 cache mirrored onto the subscriber map",
  (mapBefore.data?.caches ?? []).some((c) => c.mirrored && c.title === T_TITLE),
  JSON.stringify((mapBefore.data?.caches ?? []).map((c) => c.title)));

// erase TOMB1's account on the publisher (signed) → emits PII-free find tombstone(s), archives the cache
const dAt = now();
const dSig = b64u(await crypto.subtle.sign("Ed25519", tkp.privateKey, new TextEncoder().encode(accMsg("delete", "TOMB1", dAt))));
const tdel = await call(PUB, "POST", "/api/account/TOMB1/delete", { key: tpub, sig: dSig, at: dAt });
ok("publisher erased TOMB1 and emitted >= 1 find tombstone", tdel.data?.ok === true && (tdel.data?.tombstones ?? 0) >= 1, JSON.stringify(tdel.data));

// the tombstone feed serves a signed, PII-free find tombstone, verifiable against the publisher key
const tfeed = await call(PUB, "GET", "/federation/tombstones?since=0&limit=500");
const trec = (tfeed.data?.items ?? []).find((r) => r.data?.kind === "find" && /:find:/.test(r.data?.targetId ?? ""));
ok("tombstone feed carries a signed find tombstone", !!trec && !!trec.sig && trec.signer === pubInstance, JSON.stringify(trec));
ok("tombstone is PII-free (no callsign on the wire)", !!trec && !/TOMB1/.test(JSON.stringify(trec)), JSON.stringify(trec?.data));
let tsigOk = false;
if (trec) {
  const pk = await crypto.subtle.importKey("raw", ub64(pubWk.data.publicKey), { name: "Ed25519" }, false, ["verify"]);
  const msg = new TextEncoder().encode(stableStringify({ type: "tombstone", id: trec.id, data: trec.data }));
  tsigOk = await crypto.subtle.verify("Ed25519", pk, ub64(trec.sig), msg);
}
ok("tombstone signature verifies against the publisher key", tsigOk);

// subscriber syncs → applies the tombstone (purges the mirrored find) + re-mirrors the now-archived
// cache; the cache drops off the subscriber map
const tsync = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("subscriber applied >= 1 tombstone", (tsync.data?.tombstones ?? 0) >= 1, JSON.stringify(tsync.data));
const mapAfter = await call(SUB, "GET", `/api/caches?bbox=${BBOXT}`);
ok("TOMB1 cache removed from the subscriber map after the delete",
  !(mapAfter.data?.caches ?? []).some((c) => c.title === T_TITLE),
  JSON.stringify((mapAfter.data?.caches ?? []).map((c) => c.title)));
const peersT = await call(SUB, "GET", "/federation/peers");
ok("subscriber tombstones_cursor advanced",
  (peersT.data?.peers ?? []).some((p) => p.instance === pubInstance && p.tombstones_cursor > 0), JSON.stringify(peersT.data));

// ---- F5/T2.1: gossip ping (push-to-pull) ----
// publish a fresh cache on PUB, then ping SUB directly — it must pull immediately (no manual /sync)
const G_TITLE = "Gossip Cache " + now();
await call(PUB, "POST", "/api/caches", { title: G_TITLE, type: "single", lat: 47.09, lon: 15.44, ownerCall: "OE8APR" });
const notif = await call(SUB, "POST", "/federation/notify", { instance: pubInstance });
ok("gossip notify is accepted (202, triggers a pull)", notif.status === 202 && notif.data?.syncing === pubInstance, JSON.stringify(notif.data));
const notif2 = await call(SUB, "POST", "/federation/notify", { instance: pubInstance });
ok("a rapid repeat notify is coalesced", notif2.data?.coalesced === true, JSON.stringify(notif2.data));
let gMirrored = false;
for (let i = 0; i < 20 && !gMirrored; i++) {
  await new Promise((r) => setTimeout(r, 150));
  const gmap = await call(SUB, "GET", "/api/caches?bbox=15,46,16,48");
  gMirrored = (gmap.data?.caches ?? []).some((c) => c.mirrored && c.title === G_TITLE);
}
ok("the notify triggered an immediate pull — cache mirrored without a manual sync", gMirrored);

// ---- F5/T2.2: generalized envelope + capability negotiation ----
const wk2 = await call(PUB, "GET", "/.well-known/aprscaching");
ok("descriptor advertises protocolVersions incl. 0.2",
  Array.isArray(wk2.data?.protocolVersions) && wk2.data.protocolVersions.includes("0.2"), JSON.stringify(wk2.data?.protocolVersions));
ok("descriptor advertises every feed capability",
  ["caches", "finds", "keys", "tombstones", "notify"].every((c) => (wk2.data?.capabilities ?? []).includes(c)), JSON.stringify(wk2.data?.capabilities));
const bogusFeed = await call(PUB, "GET", "/federation/bogus");
ok("an unknown feed path 404s (the consumer skips it forward-compatibly)", bogusFeed.status === 404, `status=${bogusFeed.status}`);

// ---- F5/T2.3: push-to-hub (NAT/firewall peers contribute via submit) ----
// the publisher has no submit secret configured → the endpoint is disabled there
ok("submit is disabled where no secret is configured -> 403",
  (await call(PUB, "POST", "/federation/submit", { instance: "x", publicKey: "x", records: [] })).status === 403);
ok("submit without the secret -> 401",
  (await call(SUB, "POST", "/federation/submit", { instance: "oe.spoke", publicKey: "x", records: [] })).status === 401);

// a NAT'd spoke "oe.spoke" (which the subscriber does NOT pull) pushes a signed cache it owns
const skp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const spub = b64u(await crypto.subtle.exportKey("raw", skp.publicKey));
const spokeData = { code: "SP-0001", ownerCall: "OE0SPK", title: "Spoke Cache " + now(), type: "single", status: "active", lat: 47.5, lon: 16.0, createdAt: now(), updatedAt: now() };
const spokeId = "oe.spoke:cache:1";
const spokeSig = b64u(await crypto.subtle.sign("Ed25519", skp.privateKey, new TextEncoder().encode(stableStringify({ type: "cache", id: spokeId, data: spokeData }))));
const spokeRec = { type: "cache", id: spokeId, cursor: spokeData.updatedAt, data: spokeData, sig: spokeSig, signer: "oe.spoke" };
const sub1 = await call(SUB, "POST", "/federation/submit", { instance: "oe.spoke", publicKey: spub, records: [spokeRec] }, { "x-fed-secret": SUBMIT_SECRET });
ok("hub accepts a signed submission from a spoke (applied 1)", sub1.data?.ok === true && sub1.data?.applied === 1, JSON.stringify(sub1.data));
const smap = await call(SUB, "GET", "/api/caches?bbox=15.5,47,16.5,48");
ok("the spoke's cache is mirrored onto the hub map (push-mode mirroring)",
  (smap.data?.caches ?? []).some((c) => c.origin === "oe.spoke" && c.mirrored), JSON.stringify((smap.data?.caches ?? []).map((c) => c.origin)));

// integrity: a tampered record is rejected; impersonating the hub's own instance is refused
const tampered = { ...spokeRec, data: { ...spokeData, title: "TAMPERED" } };
const sub2 = await call(SUB, "POST", "/federation/submit", { instance: "oe.spoke", publicKey: spub, records: [tampered] }, { "x-fed-secret": SUBMIT_SECRET });
ok("a tampered submission is rejected (signature integrity)", sub2.data?.applied === 0 && sub2.data?.rejected === 1, JSON.stringify(sub2.data));
const sub3 = await call(SUB, "POST", "/federation/submit", { instance: "oe.sub", publicKey: spub, records: [] }, { "x-fed-secret": SUBMIT_SECRET });
ok("a spoke cannot submit as the hub's own instance -> 400", sub3.status === 400, JSON.stringify(sub3.data));

// ---- F6/T3.1: federated catalog on the map (origin + trust tagging; unvetted hidden by default) ----
const GBBOX = "15,46,16,48"; // covers the gossip cache (47.09,15.44) mirrored from the trusted publisher
const m0 = await call(SUB, "GET", `/api/caches?bbox=${GBBOX}`);
const gossipOnSub = (m0.data?.caches ?? []).find((c) => c.title === G_TITLE);
ok("a trusted peer's mirrored cache is tagged originTrust=trusted",
  gossipOnSub?.mirrored === true && gossipOnSub?.originTrust === "trusted", JSON.stringify(gossipOnSub));
ok("native caches are tagged originTrust=native",
  (m0.data?.caches ?? []).some((c) => !c.mirrored && c.originTrust === "native"), "no native cache in bbox");

// demote the publisher to unvetted → its caches drop off the DEFAULT map, return only with includeUnvetted
await call(SUB, "POST", "/federation/peers/trust", { url: PUB, trust: "unvetted" }, { "x-ingest-secret": SECRET });
const mDef = await call(SUB, "GET", `/api/caches?bbox=${GBBOX}`);
ok("an unvetted peer's caches are hidden from the default map",
  !(mDef.data?.caches ?? []).some((c) => c.title === G_TITLE), JSON.stringify((mDef.data?.caches ?? []).map((c) => [c.title, c.originTrust])));
const mAll = await call(SUB, "GET", `/api/caches?bbox=${GBBOX}&includeUnvetted=1`);
ok("includeUnvetted=1 surfaces them, tagged originTrust=unvetted",
  (mAll.data?.caches ?? []).find((c) => c.title === G_TITLE)?.originTrust === "unvetted", JSON.stringify(mAll.data?.includeUnvetted));

// re-promote → back on the default map
await call(SUB, "POST", "/federation/peers/trust", { url: PUB, trust: "trusted" }, { "x-ingest-secret": SECRET });
const mRe = await call(SUB, "GET", `/api/caches?bbox=${GBBOX}`);
ok("re-promoting restores the cache to the default map",
  (mRe.data?.caches ?? []).some((c) => c.title === G_TITLE && c.originTrust === "trusted"), "missing after re-promote");

// ---- F6/T3.3: owner-controlled field redaction (hint never federates; unlisted hides description; local-only never) ----
const HINT = "under the third rock from the bench";
const mkScoped = (title, fedScope) => call(PUB, "POST", "/api/caches",
  { title, type: "single", lat: 47.31, lon: 15.31, ownerCall: "OE8APR", hint: HINT, description: "full description of " + title, fedScope });
const cPub = await mkScoped("Scope Public " + now(), "public");
const cUnl = await mkScoped("Scope Unlisted " + now(), "unlisted");
const cLoc = await mkScoped("Scope Local " + now(), "local-only");
ok("scoped caches created", cPub.status === 201 && cUnl.status === 201 && cLoc.status === 201, `${cPub.status}/${cUnl.status}/${cLoc.status}`);

const cfeed = await call(PUB, "GET", "/federation/caches?since=0&limit=1000");
const citems = cfeed.data?.items ?? [];
const byT = (t) => citems.find((r) => r.data?.title === t);
const pubRec = byT(cPub.data?.cache?.title), unlRec = byT(cUnl.data?.cache?.title), locRec = byT(cLoc.data?.cache?.title);
ok("a public cache federates with description but NEVER the hint",
  !!pubRec && !("hint" in pubRec.data) && pubRec.data.description != null && pubRec.data.fedScope === "public", JSON.stringify(pubRec?.data));
ok("an unlisted cache federates without its description (and no hint)",
  !!unlRec && unlRec.data.description == null && !("hint" in unlRec.data), JSON.stringify(unlRec?.data));
ok("a local-only cache never enters the feed at all", !locRec, cLoc.data?.cache?.title);
ok("no hint text leaks anywhere in the caches feed", !new RegExp(HINT).test(JSON.stringify(cfeed.data)));

// ---- F6/T3.2: account-move as a signed federation record ----
// migrate OE7MOV onto the publisher (device-key assertion bound to oe.pub) → it announces the move
const mkp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const mpub = b64u(await crypto.subtle.exportKey("raw", mkp.publicKey));
const mvAt = now();
const mvSig = b64u(await crypto.subtle.sign("Ed25519", mkp.privateKey, new TextEncoder().encode(accMsg("migrate", "OE7MOV", mvAt))));
const imp = await call(PUB, "POST", "/api/account/import", {
  bundle: { v: 1, instance: "oe.origin", callsign: "OE7MOV", verified: true, keys: [{ publicKey: mpub, label: "dev", verified: 1 }], at: mvAt },
  assertion: { key: mpub, sig: mvSig, at: mvAt },
});
ok("account import (move) accepted on the publisher", imp.data?.ok === true, JSON.stringify(imp.data));

const mfeed = await call(PUB, "GET", "/federation/account-moves?since=0&limit=100");
const mrec = (mfeed.data?.items ?? []).find((r) => r.data?.callsign === "OE7MOV");
ok("account-move feed carries the signed move (homed to the publisher)",
  !!mrec && mrec.data.toInstance === pubInstance && mrec.data.fromInstance === "oe.origin" && !!mrec.sig && mrec.signer === pubInstance, JSON.stringify(mrec));
let mvOk = false;
if (mrec) {
  const pk = await crypto.subtle.importKey("raw", ub64(pubWk.data.publicKey), { name: "Ed25519" }, false, ["verify"]);
  const msg = new TextEncoder().encode(stableStringify({ type: "account-move", id: mrec.id, data: mrec.data }));
  mvOk = await crypto.subtle.verify("Ed25519", pk, ub64(mrec.sig), msg);
}
ok("the move record signature verifies against the publisher key", mvOk);

const msync = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("subscriber mirrors the account move", (msync.data?.moves ?? 0) >= 1, JSON.stringify(msync.data));
const mpeers = await call(SUB, "GET", "/federation/peers");
ok("subscriber moves_cursor advanced", (mpeers.data?.peers ?? []).some((p) => p.instance === pubInstance && p.moves_cursor > 0), JSON.stringify(mpeers.data));

// ---- F7/T4.3: federation observability ----
const hpeers = await call(SUB, "GET", "/federation/peers");
const pubPeer = (hpeers.data?.peers ?? []).find((p) => p.instance === pubInstance);
ok("peer health metrics tracked (health ok, sync_ok>0, mirrored_total>0)",
  pubPeer?.health === "ok" && pubPeer?.sync_ok > 0 && pubPeer?.mirrored_total > 0,
  JSON.stringify(pubPeer && { health: pubPeer.health, sync_ok: pubPeer.sync_ok, total: pubPeer.mirrored_total }));
ok("the last sync's per-feed breakdown is reported", pubPeer?.lastCounts && typeof pubPeer.lastCounts === "object", JSON.stringify(pubPeer?.lastCounts));
ok("a healthy peer has last_ok set and a zero error rate", pubPeer?.last_ok != null && pubPeer?.errorRate === 0, JSON.stringify({ last_ok: pubPeer?.last_ok, errorRate: pubPeer?.errorRate }));
// T1.1 reputation: the publisher corroborated finds that reached Tier A → it earned rep_confirmed
ok("a corroborating peer earns reputation (rep_confirmed > 0)", (pubPeer?.rep_confirmed ?? 0) > 0, JSON.stringify({ rep_confirmed: pubPeer?.rep_confirmed }));

// ---- F7/T4.1: key rotation + multi-key + revocation ----
// The publisher is started with FED_KEY_HISTORY (an extra active key + a revoked one), so every
// mirror assertion above already exercises multi-key verification (current key ∈ the active set).
const wkk = await call(PUB, "GET", "/.well-known/aprscaching");
const pks = wkk.data?.publicKeys ?? [];
ok("well-known publishes a publicKeys[] including the current signing key",
  Array.isArray(pks) && pks.some((k) => k.x === wkk.data.publicKey), JSON.stringify(pks));
ok("publicKeys carries an extra active key (multi-key) and a revoked one",
  pks.length >= 3 && pks.some((k) => k.revoked === true), JSON.stringify(pks.map((k) => [k.x?.slice(0, 6), !!k.revoked])));

// ---- F7/T4.2: signed instance registry / namespace authority ----
// The subscriber is started with a signed FED_REGISTRY binding oe.pub → the publisher's real key, so
// every mirror assertion above already passed the anti-spoof check (the published key matched the
// registry). A mismatched key would have thrown and blocked the sync (unit-tested separately).
const regResp = await call(SUB, "GET", "/federation/registry");
ok("the signed registry is loaded + verified, binding the publisher instance",
  regResp.data?.verified === true && (regResp.data?.entries ?? []).some((e) => e.instance === pubInstance && e.key),
  JSON.stringify(regResp.data?.entries));
ok("an instance self-publishes its operator + APRS service address",
  wkk.data?.operator === "OE8APR" && wkk.data?.aprsCall === "OE8APR-12",
  JSON.stringify({ operator: wkk.data?.operator, aprsCall: wkk.data?.aprsCall }));

// ---- F4/T1.2: corroboration privacy coarsening + endpoint hardening ----
// (must run LAST — the rate-limit probe trips the shared in-memory IP bucket on the publisher)
const probe = await call(PUB, "POST", "/federation/corroborate",
  { callsign: "LO3RF", lat: LAT, lon: LON, radiusM: 200, since: t - 3600, until: t + 3600 });
ok("a direct corroboration probe is answered", probe.data?.corroborated === true, JSON.stringify(probe.data));
ok("the response distance is bucketed (no exact metres)",
  Number.isInteger((probe.data?.evidence?.distanceM ?? 1) / 100), JSON.stringify(probe.data?.evidence));
ok("the response hides the exact IGate by default", probe.data?.evidence?.igateCall === undefined, JSON.stringify(probe.data?.evidence));
ok("no IGate callsign leaks on the wire (not a location oracle)", !/OE8XXX/.test(JSON.stringify(probe.data)), JSON.stringify(probe.data));

let got429 = false;
for (let i = 0; i < 70 && !got429; i++) {
  const r = await call(PUB, "POST", "/federation/corroborate", { callsign: "FLOOD1", lat: 0, lon: 0, radiusM: 10, since: 0, until: 1 });
  if (r.status === 429) got429 = true;
}
ok("the corroboration endpoint rate-limits abusive probing (429)", got429);

console.log(failures ? `\nFEDERATION FAILED (${failures})` : "\nFEDERATION CONFORMANCE PASSED");
process.exit(failures ? 1 : 0);
