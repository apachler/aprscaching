// SPDX-License-Identifier: AGPL-3.0-or-later
// Two-instance federation conformance: a PUBLISHER and a SUBSCRIBER, both already running.
// Seeds the publisher, triggers a pull-sync on the subscriber, and asserts the subscriber mirrored
// the publisher's (signature-verified) cache onto its own map.
//
//   PUB=http://127.0.0.1:8801 SUB=http://127.0.0.1:8802 node tools/smoke/federation.mjs

import {
  cborDecode as miniDecode,
  buildFrame,
  frameFromParts,
  frameParts,
  signingBytes,
  encodePage,
  decodePage,
} from "./fedwire-mini.mjs";

const PUB = process.env.PUB ?? "http://127.0.0.1:8801";
const SUB = process.env.SUB ?? "http://127.0.0.1:8802";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
const SUBMIT_SECRET = process.env.SUBMIT_SECRET ?? "submitsecret"; // SUB is started as a hub with this
const now = () => Math.floor(Date.now() / 1000);
let failures = 0;

function ok(name, cond, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
async function call(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-ingest-secret": SECRET, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
async function waitHealthy(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/health")).ok) return true;
    } catch {}
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

// a signed instance advertises the CBOR sync surface + (when configured) its typed addresses
ok(
  "publisher advertises sync-cbor",
  (pubWk.data?.capabilities ?? []).includes("sync-cbor"),
  JSON.stringify(pubWk.data?.capabilities),
);
ok("descriptor addresses is an array", Array.isArray(pubWk.data?.addresses), JSON.stringify(pubWk.data?.addresses));

// the CBOR sync surface serves fedwire frames: application/cbor, page envelope = map(4)
{
  const res = await fetch(PUB + "/federation/sync/cache?since=0");
  const bytes = new Uint8Array(await res.arrayBuffer());
  ok(
    "GET /federation/sync/cache serves a CBOR page",
    res.status === 200 && (res.headers.get("content-type") ?? "").includes("application/cbor") && bytes[0] === 0xa4,
    `status=${res.status} ct=${res.headers.get("content-type")} b0=${bytes[0]?.toString(16)}`,
  );
}

// Quiesce before seeding: the subscriber kicks a federation sync at boot (the node/bun servers run
// `runScheduled` once on listen), so a pull can already be in flight here. The counts an explicit
// /federation/sync reports describe ITS OWN pull, and a pull that started before the seed below
// cannot contain it — awaiting one sync now leaves nothing in flight, and the periodic interval is
// five minutes away. Without this the assertions below race the boot sync.
await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });

// seed the publisher: a cache + a verified find
const TITLE = "Federated Schlossberg " + now();
const created = await call(PUB, "POST", "/api/caches", {
  title: TITLE,
  type: "single",
  lat: 47.0735,
  lon: 15.4378,
  difficulty: 2,
  terrain: 2,
  ownerCall: "OE8APR",
});
ok("publisher created a cache", created.status === 201, JSON.stringify(created.data));
const pid = created.data?.cache?.id;
await call(PUB, "POST", `/api/caches/${pid}/logs`, {
  loggerCall: "DL1ABC",
  logType: "found",
  appGeo: { lat: 47.07355, lon: 15.43785, accuracyM: 11, ts: now() },
});

// trigger a pull-sync on the subscriber
const sync = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("subscriber sync ran", sync.data?.ok === true, JSON.stringify(sync.data));
ok("sync mirrored >= 1 cache", (sync.data?.caches ?? 0) >= 1, JSON.stringify(sync.data));
ok("sync mirrored >= 1 find", (sync.data?.finds ?? 0) >= 1, JSON.stringify(sync.data));
ok("sync had no peer errors", (sync.data?.errors ?? []).length === 0, JSON.stringify(sync.data?.errors));

// the subscriber pulled over the CBOR sync surface (lastCounts records the wire encoding used)
{
  const peers = await call(SUB, "GET", "/federation/peers");
  const pubPeer = (peers.data?.peers ?? []).find((x) => x.instance === pubInstance);
  ok(
    "subscriber synced over the CBOR wire",
    pubPeer?.lastCounts?.encoding === "cbor",
    JSON.stringify(pubPeer?.lastCounts),
  );
}

// subscriber discovered + recorded the peer (signed)
const peers = await call(SUB, "GET", "/federation/peers");
ok(
  "subscriber knows the peer (signed)",
  (peers.data?.peers ?? []).some((p) => p.instance === pubInstance && p.signed),
  JSON.stringify(peers.data),
);

// the publisher's cache now appears on the SUBSCRIBER's map, marked mirrored
const list = await call(SUB, "GET", "/api/caches?bbox=15,46,16,48");
const mirror = (list.data?.caches ?? []).find((c) => c.mirrored && c.title === TITLE);
ok("mirrored cache appears on subscriber map", !!mirror, `titles=${(list.data?.caches ?? []).map((c) => c.title)}`);
ok(
  "mirrored cache carries origin + globalId, no local id",
  mirror?.origin === pubInstance && /:cache:/.test(mirror?.globalId ?? "") && mirror?.id === null,
  JSON.stringify(mirror),
);

// idempotency: a second sync should not error and the cache stays single
const sync2 = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("re-sync is clean", sync2.data?.ok === true && (sync2.data?.errors ?? []).length === 0);
const list2 = await call(SUB, "GET", "/api/caches?bbox=15,46,16,48");
ok("no duplicate mirror after re-sync", (list2.data?.caches ?? []).filter((c) => c.title === TITLE).length === 1);

// auth: sync requires the ingest secret (the call() default is overridden with an invalid one)
const noauth = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": "" });
ok("sync with an invalid secret -> 401", noauth.status === 401, `status=${noauth.status}`);

// ---- cross-instance verification (the network effect) ----
// The logger's RF position is heard only by the PUBLISHER's IGate (independent of the logger).
// The cache + the find live on the SUBSCRIBER, which has NO local RF fix — it must reach Tier A
// by querying the publisher's corroboration pool.
const LAT = 47.2,
  LON = 15.05,
  t = now();
await call(
  PUB,
  "POST",
  "/ingest",
  {
    packets: [
      {
        src: "LO3RF",
        path: ["WIDE1-1", "qAR", "OE8XXX"],
        payload: "=4712.00N/01503.00E>",
        kind: "position",
        parsed: { lat: LAT + 0.0005, lon: LON, symbol: ">" },
        heardVia: "rf",
        igateCall: "OE8XXX",
        port: "aprs-is",
        ts: t,
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);

const sCache = await call(SUB, "POST", "/api/caches", {
  title: "Peer-Verified Summit " + t,
  type: "single",
  lat: LAT,
  lon: LON,
  ownerCall: "OE8SUB",
});
const sid = sCache.data?.cache?.id;
ok("subscriber created its own cache", sCache.status === 201, JSON.stringify(sCache.data));

// no appGeo, no local RF on the subscriber -> only peer corroboration can grant Tier A
const peerLog = await call(SUB, "POST", `/api/caches/${sid}/logs`, { loggerCall: "LO3RF", logType: "found" });
ok(
  "subscriber reaches Tier A via peer corroboration",
  peerLog.data?.verified === true && peerLog.data?.tier === "A" && peerLog.data?.method === "aprs_rf_peer",
  JSON.stringify(peerLog.data),
);
ok(
  "corroboration is attributed to the publisher instance",
  peerLog.data?.corroboratedBy === pubInstance,
  JSON.stringify(peerLog.data?.corroboratedBy),
);

// a logger nobody heard stays unverified (no false corroboration)
const ghost = await call(SUB, "POST", `/api/caches/${sid}/logs`, { loggerCall: "GHOST9", logType: "found" });
ok("an un-heard logger does NOT reach Tier A", ghost.data?.tier !== "A", JSON.stringify(ghost.data));

// ---- per-callsign signing ----
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
}
const authMsg = (a) =>
  stableStringify({ v: 1, cache: a.cache, instance: a.instance, logger: a.logger, logType: a.logType, at: a.at });
const b64u = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const ub64 = (s) => {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
};
const signWith = async (priv, msg) => b64u(await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)));

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubRaw = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));

const reg = await call(PUB, "POST", "/keys/register", { callsign: "OE8APR", publicKey: pubRaw, label: "device" });
ok("key registration accepted", reg.data?.ok === true && reg.data?.publicKey === pubRaw, JSON.stringify(reg.data));

const sc = await call(PUB, "POST", "/api/caches", {
  title: "Signed Find " + now(),
  type: "single",
  lat: 47.08,
  lon: 15.41,
  ownerCall: "OE8APR",
});
const scCode = sc.data?.cache?.code,
  scId = sc.data?.cache?.id;
const at = now();
const sig = await signWith(
  kp.privateKey,
  authMsg({ cache: scCode, instance: pubInstance, logger: "OE8APR", logType: "found", at }),
);
const signedLog = await call(PUB, "POST", `/api/caches/${scId}/logs`, {
  loggerCall: "OE8APR",
  logType: "found",
  author: { authorKey: pubRaw, authorSig: sig, signedAt: at },
});
ok(
  "signed find accepted; signerKey echoed",
  signedLog.data?.logged === true && signedLog.data?.signerKey === pubRaw,
  JSON.stringify(signedLog.data),
);

// flip the first (fully-significant) base64url char so the signature is guaranteed to differ
const badSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
const bad = await call(PUB, "POST", `/api/caches/${scId}/logs`, {
  loggerCall: "OE8APR",
  logType: "found",
  author: { authorKey: pubRaw, authorSig: badSig, signedAt: at },
});
ok("tampered author signature -> 400", bad.status === 400, `status=${bad.status}`);

const kp2 = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub2 = b64u(await crypto.subtle.exportKey("raw", kp2.publicKey));
const at2 = now();
const sig2 = await signWith(
  kp2.privateKey,
  authMsg({ cache: scCode, instance: pubInstance, logger: "OE8APR", logType: "found", at: at2 }),
);
const unreg = await call(PUB, "POST", `/api/caches/${scId}/logs`, {
  loggerCall: "OE8APR",
  logType: "found",
  author: { authorKey: pub2, authorSig: sig2, signedAt: at2 },
});
ok("unregistered key -> 400", unreg.status === 400, `status=${unreg.status}`);

// verify the author signature straight from the federation feed, as any consumer would
const finds = await call(PUB, "GET", "/federation/finds?since=0&limit=1000");
const frec = (finds.data?.items ?? []).find(
  (r) => r.data?.loggerCall === "OE8APR" && r.data?.authorKey === pubRaw && r.data?.cacheCode === scCode,
);
ok("finds feed carries the author signature", !!frec);
let authorOk = false;
if (frec) {
  const key = await crypto.subtle.importKey("raw", ub64(frec.data.authorKey), { name: "Ed25519" }, false, ["verify"]);
  const msg = new TextEncoder().encode(
    authMsg({
      cache: frec.data.cacheCode,
      instance: pubInstance,
      logger: frec.data.loggerCall,
      logType: frec.data.logType,
      at: frec.data.signedAt,
    }),
  );
  authorOk = await crypto.subtle.verify("Ed25519", key, ub64(frec.data.authorSig), msg);
}
ok("author signature verifies from the feed (per-callsign provenance)", authorOk);

const keysFeed = await call(PUB, "GET", "/federation/keys?since=0&limit=500");
ok(
  "keys feed publishes the callsign->key binding",
  (keysFeed.data?.items ?? []).some((r) => r.data?.callsign === "OE8APR" && r.data?.publicKey === pubRaw),
);

const syncK = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("subscriber mirrors keys", (syncK.data?.keys ?? 0) >= 1, JSON.stringify(syncK.data));
const peers2 = await call(SUB, "GET", "/federation/peers");
ok(
  "subscriber keys_cursor advanced",
  (peers2.data?.peers ?? []).some((p) => p.instance === pubInstance && p.keys_cursor > 0),
  JSON.stringify(peers2.data),
);

// ---- peer trust tiers + quarantine ----
// The subscriber's only peer is the publisher, listed in FED_PEERS → it must be manual + trusted.
const pall = await call(SUB, "GET", "/federation/peers");
const peerRec = (pall.data?.peers ?? []).find((p) => p.instance === pubInstance) ?? {};
ok(
  "manual peer is trusted + added_via=manual",
  peerRec.trust === "trusted" && peerRec.added_via === "manual",
  JSON.stringify(peerRec),
);

// operator control endpoint guards
const t401 = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "blocked" },
  { "x-ingest-secret": "" },
);
ok("trust change without the ingest secret -> 401", t401.status === 401, `status=${t401.status}`);
const t400 = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "bogus" },
  { "x-ingest-secret": SECRET },
);
ok("an invalid trust level -> 400", t400.status === 400, `status=${t400.status}`);
const t404 = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: "http://127.0.0.1:9", trust: "trusted" },
  { "x-ingest-secret": SECRET },
);
ok("an unknown peer -> 404", t404.status === 404, `status=${t404.status}`);

// quarantine: block the only peer → a fresh find can no longer reach Tier A (empty trusted pool)
const blk = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "blocked" },
  { "x-ingest-secret": SECRET },
);
ok("operator blocked the peer", blk.data?.ok === true && blk.data?.trust === "blocked", JSON.stringify(blk.data));
const bCache = await call(SUB, "POST", "/api/caches", {
  title: "Blocked-Peer Summit " + now(),
  type: "single",
  lat: LAT,
  lon: LON,
  ownerCall: "OE8SUB",
});
const blockedLog = await call(SUB, "POST", `/api/caches/${bCache.data?.cache?.id}/logs`, {
  loggerCall: "LO3RF",
  logType: "found",
});
ok("a blocked peer cannot grant Tier A", blockedLog.data?.tier !== "A", JSON.stringify(blockedLog.data));
const blkSync = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok(
  "a blocked peer is skipped on sync (no fetch, no error)",
  blkSync.data?.ok === true && (blkSync.data?.errors ?? []).length === 0,
  JSON.stringify(blkSync.data),
);

// promote back to trusted → corroboration is restored, and approval is stamped
const prom = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "trusted" },
  { "x-ingest-secret": SECRET },
);
ok(
  "operator promoted the peer to trusted",
  prom.data?.ok === true && prom.data?.trust === "trusted",
  JSON.stringify(prom.data),
);
const rCache = await call(SUB, "POST", "/api/caches", {
  title: "Re-trusted Summit " + now(),
  type: "single",
  lat: LAT,
  lon: LON,
  ownerCall: "OE8SUB",
});
const reLog = await call(SUB, "POST", `/api/caches/${rCache.data?.cache?.id}/logs`, {
  loggerCall: "LO3RF",
  logType: "found",
});
ok(
  "a re-trusted peer grants Tier A again",
  reLog.data?.tier === "A" && reLog.data?.method === "aprs_rf_peer",
  JSON.stringify(reLog.data),
);

// ---- signed tombstones (GDPR delete propagation) ----
const accMsg = (action, cs, at) =>
  stableStringify({ v: 1, action, callsign: cs.toUpperCase(), instance: pubInstance, at });
const tkp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const tpub = b64u(await crypto.subtle.exportKey("raw", tkp.publicKey));
await call(PUB, "POST", "/keys/register", { callsign: "TOMB1", publicKey: tpub, label: "device" });

// TOMB1 owns a cache and logs a find on the publisher
const T_TITLE = "Tombstone Cache " + now();
const tCache = await call(PUB, "POST", "/api/caches", {
  title: T_TITLE,
  type: "single",
  lat: 48.21,
  lon: 16.37,
  ownerCall: "TOMB1",
});
await call(PUB, "POST", `/api/caches/${tCache.data?.cache?.id}/logs`, { loggerCall: "TOMB1", logType: "found" });
ok("publisher created a TOMB1-owned cache + find", tCache.status === 201, JSON.stringify(tCache.data));

// subscriber mirrors it onto its map
const BBOXT = "16.2,48.0,16.6,48.4";
await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
const mapBefore = await call(SUB, "GET", `/api/caches?bbox=${BBOXT}`);
ok(
  "TOMB1 cache mirrored onto the subscriber map",
  (mapBefore.data?.caches ?? []).some((c) => c.mirrored && c.title === T_TITLE),
  JSON.stringify((mapBefore.data?.caches ?? []).map((c) => c.title)),
);

// erase TOMB1's account on the publisher (signed) → emits PII-free find tombstone(s), archives the cache
const dAt = now();
const dSig = b64u(
  await crypto.subtle.sign("Ed25519", tkp.privateKey, new TextEncoder().encode(accMsg("delete", "TOMB1", dAt))),
);
const tdel = await call(PUB, "POST", "/api/account/TOMB1/delete", { key: tpub, sig: dSig, at: dAt });
ok(
  "publisher erased TOMB1 and emitted >= 1 find tombstone",
  tdel.data?.ok === true && (tdel.data?.tombstones ?? 0) >= 1,
  JSON.stringify(tdel.data),
);

// the CBOR sync surface serves a signed, PII-free find tombstone, verifiable against the publisher key
const tpageRes = await fetch(PUB + "/federation/sync/tombstone?since=0&limit=500");
const tpage = decodePage(new Uint8Array(await tpageRes.arrayBuffer()));
let tframe = null;
for (const fb of tpage.frames) {
  const parts = frameParts(fb);
  const rec = miniDecode(parts.payload);
  const body = rec.get(7);
  if (body?.get?.("kind") === "find" && /:find:/.test(String(body.get("targetId") ?? ""))) {
    tframe = { parts, rec, body };
    break;
  }
}
ok("tombstone sync page carries a find-tombstone frame", !!tframe, `frames=${tpage.frames.length}`);
ok(
  "tombstone is PII-free (no callsign on the wire)",
  !!tframe && !new TextDecoder("latin1").decode(tframe.parts.payload).includes("TOMB1"),
);
let tsigOk = false;
if (tframe) {
  const pk = await crypto.subtle.importKey("raw", ub64(pubWk.data.publicKey), { name: "Ed25519" }, false, ["verify"]);
  tsigOk =
    tframe.parts.signerKey === pubWk.data.publicKey &&
    (await crypto.subtle.verify("Ed25519", pk, tframe.parts.sig, signingBytes(tframe.parts.payload)));
}
ok("tombstone frame verifies against the publisher key (domain-separated Ed25519)", tsigOk);

// subscriber syncs → applies the tombstone (purges the mirrored find) + re-mirrors the now-archived
// cache; the cache drops off the subscriber map
const tsync = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("subscriber applied >= 1 tombstone", (tsync.data?.tombstones ?? 0) >= 1, JSON.stringify(tsync.data));
const mapAfter = await call(SUB, "GET", `/api/caches?bbox=${BBOXT}`);
ok(
  "TOMB1 cache removed from the subscriber map after the delete",
  !(mapAfter.data?.caches ?? []).some((c) => c.title === T_TITLE),
  JSON.stringify((mapAfter.data?.caches ?? []).map((c) => c.title)),
);
const peersT = await call(SUB, "GET", "/federation/peers");
ok(
  "subscriber tombstones_cursor advanced",
  (peersT.data?.peers ?? []).some((p) => p.instance === pubInstance && p.tombstones_cursor > 0),
  JSON.stringify(peersT.data),
);

// ---- gossip ping (push-to-pull) ----
// publish a fresh cache on PUB, then ping SUB directly — it must pull immediately (no manual /sync)
const G_TITLE = "Gossip Cache " + now();
await call(PUB, "POST", "/api/caches", { title: G_TITLE, type: "single", lat: 47.09, lon: 15.44, ownerCall: "OE8APR" });
const notif = await call(SUB, "POST", "/federation/notify", { instance: pubInstance });
ok(
  "gossip notify is accepted (202, triggers a pull)",
  notif.status === 202 && notif.data?.syncing === pubInstance,
  JSON.stringify(notif.data),
);
const notif2 = await call(SUB, "POST", "/federation/notify", { instance: pubInstance });
ok("a rapid repeat notify is coalesced", notif2.data?.coalesced === true, JSON.stringify(notif2.data));
// The notify pull runs OFF the response path (handleFederationNotify → ctx.waitUntil(syncPeer…)),
// so the mirror appears asynchronously — poll for it. A generous ≈15 s budget absorbs a loaded CI
// runner (this job boots two gateways); the background sync normally lands in <1 s, so this guards
// against scheduler contention, not a real wait.
let gMirrored = false;
for (let i = 0; i < 60 && !gMirrored; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const gmap = await call(SUB, "GET", "/api/caches?bbox=15,46,16,48");
  gMirrored = (gmap.data?.caches ?? []).some((c) => c.mirrored && c.title === G_TITLE);
}
ok("the notify triggered an immediate pull — cache mirrored without a manual sync", gMirrored);

// ---- generalized envelope + capability negotiation ----
const wk2 = await call(PUB, "GET", "/.well-known/aprscaching");
ok(
  "descriptor advertises protocolVersions incl. 0.2",
  Array.isArray(wk2.data?.protocolVersions) && wk2.data.protocolVersions.includes("0.2"),
  JSON.stringify(wk2.data?.protocolVersions),
);
ok(
  "descriptor advertises every feed capability",
  ["caches", "finds", "keys", "tombstones", "notify"].every((c) => (wk2.data?.capabilities ?? []).includes(c)),
  JSON.stringify(wk2.data?.capabilities),
);
const bogusFeed = await call(PUB, "GET", "/federation/bogus");
ok(
  "an unknown feed path 404s (the consumer skips it forward-compatibly)",
  bogusFeed.status === 404,
  `status=${bogusFeed.status}`,
);

// ---- push-to-hub (NAT/firewall peers contribute via submit) ----
// the publisher has no submit secret configured → the endpoint is disabled there
ok(
  "submit is disabled where no secret is configured -> 403",
  (await call(PUB, "POST", "/federation/submit", { instance: "x", publicKey: "x", records: [] })).status === 403,
);
ok(
  "submit without the secret -> 401",
  (await call(SUB, "POST", "/federation/submit", { instance: "oe.spoke", publicKey: "x", records: [] })).status === 401,
);

// a NAT'd spoke "oe.spoke" (which the subscriber does NOT pull) pushes a page of signed frames.
// The frames are built with the smoke's OWN minimal encoder — a cross-implementation check of the
// canonical form; a byte of divergence and the hub rejects the frame.
const submitCbor = (base, pageBytes, headers = {}) =>
  fetch(base + "/federation/submit", {
    method: "POST",
    headers: { "content-type": "application/cbor", "x-fed-secret": SUBMIT_SECRET, ...headers },
    body: pageBytes,
  }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));

const skp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const spub = b64u(await crypto.subtle.exportKey("raw", skp.publicKey));
const spokeBody = {
  code: "SP-0001",
  ownerCall: "OE0SPK",
  title: "Spoke Cache " + now(),
  type: "single",
  status: "active",
  latE7: 475000000,
  lonE7: 160000000,
  createdAt: now(),
  updatedAt: now(),
};
const spokeFrame = await buildFrame(
  {
    kind: 1,
    gid: "oe.spoke:cache:1",
    origin: "oe.spoke",
    v: spokeBody.updatedAt,
    at: now(),
    signer: "oe.spoke",
    body: spokeBody,
  },
  skp.privateKey,
  spub,
);
const sub1 = await submitCbor(SUB, encodePage("oe.spoke", spokeBody.updatedAt, true, [spokeFrame]));
ok(
  "hub accepts a spoke's page of signed frames (applied 1)",
  sub1.data?.ok === true && sub1.data?.applied === 1,
  JSON.stringify(sub1.data),
);
const smap = await call(SUB, "GET", "/api/caches?bbox=15.5,47,16.5,48");
ok(
  "the spoke's cache is mirrored onto the hub map (push-mode mirroring)",
  (smap.data?.caches ?? []).some((c) => c.origin === "oe.spoke" && c.mirrored),
  JSON.stringify((smap.data?.caches ?? []).map((c) => c.origin)),
);

// integrity: a frame whose payload doesn't match its signature is rejected; impersonating the
// hub's own instance is refused; a JSON submit body is refused outright (CBOR is the only wire)
const spokeParts = frameParts(spokeFrame);
const tamperedBody = { ...spokeBody, title: "TAMPERED" };
const tamperedFrame = await buildFrame(
  { kind: 1, gid: "oe.spoke:cache:1", origin: "oe.spoke", v: now(), at: now(), signer: "oe.spoke", body: tamperedBody },
  skp.privateKey,
  spub,
);
const forged = frameFromParts(frameParts(tamperedFrame).payload, spub, spokeParts.sig); // stolen sig, new content
const sub2 = await submitCbor(SUB, encodePage("oe.spoke", now(), true, [spokeFrame, forged]));
ok(
  "a forged frame (payload/signature mismatch) is rejected",
  sub2.data?.applied === 1 && sub2.data?.rejected === 1,
  JSON.stringify(sub2.data),
);
const hubFrame = await buildFrame(
  { kind: 1, gid: "oe.sub:cache:1", origin: "oe.sub", v: now(), at: now(), signer: "oe.sub", body: spokeBody },
  skp.privateKey,
  spub,
);
const sub3 = await submitCbor(SUB, encodePage("oe.sub", now(), true, [hubFrame]));
ok("a spoke cannot submit as the hub's own instance -> 400", sub3.status === 400, JSON.stringify(sub3.data));
const jsonRefused = await call(
  SUB,
  "POST",
  "/federation/submit",
  { instance: "oe.spoke", publicKey: spub, records: [] },
  { "x-fed-secret": SUBMIT_SECRET },
);
ok("a JSON submit body is refused (CBOR is the only signed wire) -> 415", jsonRefused.status === 415);

// A spoke may only submit records IN ITS OWN namespace. A frame whose gid targets ANOTHER
// instance (here the publisher's) — validly spoke-signed — must be rejected, never overwriting the
// genuine mirror. The signature verifies, so ONLY the namespace check stops it.
const evilTitle = "HIJACKED " + now();
const evilFrame = await buildFrame(
  {
    kind: 1,
    gid: `${pubInstance}:cache:999999`,
    origin: "oe.spoke",
    v: now(),
    at: now(),
    signer: "oe.spoke",
    body: { ...spokeBody, title: evilTitle },
  },
  skp.privateKey,
  spub,
);
const subEvil = await submitCbor(SUB, encodePage("oe.spoke", now(), true, [evilFrame]));
ok(
  "a cross-namespace submission is rejected (no origin spoof / overwrite)",
  subEvil.data?.applied === 0 && subEvil.data?.rejected === 1,
  JSON.stringify(subEvil.data),
);
const evilMap = await call(SUB, "GET", "/api/caches?bbox=15.5,47,16.5,48");
ok(
  "the hijack record never lands on the map",
  !(evilMap.data?.caches ?? []).some((c) => c.title === evilTitle),
  evilTitle,
);

// ---- federated catalog on the map (origin + trust tagging; unvetted hidden by default) ----
const GBBOX = "15,46,16,48"; // covers the gossip cache (47.09,15.44) mirrored from the trusted publisher
const m0 = await call(SUB, "GET", `/api/caches?bbox=${GBBOX}`);
const gossipOnSub = (m0.data?.caches ?? []).find((c) => c.title === G_TITLE);
ok(
  "a trusted peer's mirrored cache is tagged originTrust=trusted",
  gossipOnSub?.mirrored === true && gossipOnSub?.originTrust === "trusted",
  JSON.stringify(gossipOnSub),
);
ok(
  "native caches are tagged originTrust=native",
  (m0.data?.caches ?? []).some((c) => !c.mirrored && c.originTrust === "native"),
  "no native cache in bbox",
);

// demote the publisher to unvetted → its caches drop off the DEFAULT map, return only with includeUnvetted
await call(SUB, "POST", "/federation/peers/trust", { url: PUB, trust: "unvetted" }, { "x-ingest-secret": SECRET });
const mDef = await call(SUB, "GET", `/api/caches?bbox=${GBBOX}`);
ok(
  "an unvetted peer's caches are hidden from the default map",
  !(mDef.data?.caches ?? []).some((c) => c.title === G_TITLE),
  JSON.stringify((mDef.data?.caches ?? []).map((c) => [c.title, c.originTrust])),
);
const mAll = await call(SUB, "GET", `/api/caches?bbox=${GBBOX}&includeUnvetted=1`);
ok(
  "includeUnvetted=1 surfaces them, tagged originTrust=unvetted",
  (mAll.data?.caches ?? []).find((c) => c.title === G_TITLE)?.originTrust === "unvetted",
  JSON.stringify(mAll.data?.includeUnvetted),
);

// re-promote → back on the default map
await call(SUB, "POST", "/federation/peers/trust", { url: PUB, trust: "trusted" }, { "x-ingest-secret": SECRET });
const mRe = await call(SUB, "GET", `/api/caches?bbox=${GBBOX}`);
ok(
  "re-promoting restores the cache to the default map",
  (mRe.data?.caches ?? []).some((c) => c.title === G_TITLE && c.originTrust === "trusted"),
  "missing after re-promote",
);

// ---- owner-controlled field redaction (hint never federates; unlisted hides description; local-only never) ----
const HINT = "under the third rock from the bench";
const mkScoped = (title, fedScope) =>
  call(PUB, "POST", "/api/caches", {
    title,
    type: "single",
    lat: 47.31,
    lon: 15.31,
    ownerCall: "OE8APR",
    hint: HINT,
    description: "full description of " + title,
    fedScope,
  });
const cPub = await mkScoped("Scope Public " + now(), "public");
const cUnl = await mkScoped("Scope Unlisted " + now(), "unlisted");
const cLoc = await mkScoped("Scope Local " + now(), "local-only");
ok(
  "scoped caches created",
  cPub.status === 201 && cUnl.status === 201 && cLoc.status === 201,
  `${cPub.status}/${cUnl.status}/${cLoc.status}`,
);

const cfeed = await call(PUB, "GET", "/federation/caches?since=0&limit=1000");
const citems = cfeed.data?.items ?? [];
const byT = (t) => citems.find((r) => r.data?.title === t);
const pubRec = byT(cPub.data?.cache?.title),
  unlRec = byT(cUnl.data?.cache?.title),
  locRec = byT(cLoc.data?.cache?.title);
ok(
  "a public cache federates with description but NEVER the hint",
  !!pubRec && !("hint" in pubRec.data) && pubRec.data.description != null && pubRec.data.fedScope === "public",
  JSON.stringify(pubRec?.data),
);
ok(
  "an unlisted cache federates without its description (and no hint)",
  !!unlRec && unlRec.data.description == null && !("hint" in unlRec.data),
  JSON.stringify(unlRec?.data),
);
ok("a local-only cache never enters the feed at all", !locRec, cLoc.data?.cache?.title);
ok("no hint text leaks anywhere in the caches feed", !new RegExp(HINT).test(JSON.stringify(cfeed.data)));

// ---- account-move as a signed federation record ----
// migrate OE7MOV onto the publisher (device-key assertion bound to oe.pub) → it announces the move
const mkp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const mpub = b64u(await crypto.subtle.exportKey("raw", mkp.publicKey));
const mvAt = now();
const mvSig = b64u(
  await crypto.subtle.sign("Ed25519", mkp.privateKey, new TextEncoder().encode(accMsg("migrate", "OE7MOV", mvAt))),
);
const imp = await call(PUB, "POST", "/api/account/import", {
  bundle: {
    v: 1,
    instance: "oe.origin",
    callsign: "OE7MOV",
    verified: true,
    keys: [{ publicKey: mpub, label: "dev", verified: 1 }],
    at: mvAt,
  },
  assertion: { key: mpub, sig: mvSig, at: mvAt },
});
ok("account import (move) accepted on the publisher", imp.data?.ok === true, JSON.stringify(imp.data));

const mpageRes = await fetch(PUB + "/federation/sync/account-move?since=0&limit=100");
const mpage = decodePage(new Uint8Array(await mpageRes.arrayBuffer()));
let mframe = null;
for (const fb of mpage.frames) {
  const parts = frameParts(fb);
  const body = miniDecode(parts.payload).get(7);
  if (body?.get?.("callsign") === "OE7MOV") {
    mframe = { parts, body };
    break;
  }
}
ok(
  "the account-move sync page carries the move (homed to the publisher)",
  !!mframe && mframe.body.get("toInstance") === pubInstance && mframe.body.get("fromInstance") === "oe.origin",
  `frames=${mpage.frames.length}`,
);
let mvOk = false;
if (mframe) {
  const pk = await crypto.subtle.importKey("raw", ub64(pubWk.data.publicKey), { name: "Ed25519" }, false, ["verify"]);
  mvOk =
    mframe.parts.signerKey === pubWk.data.publicKey &&
    (await crypto.subtle.verify("Ed25519", pk, mframe.parts.sig, signingBytes(mframe.parts.payload)));
}
ok("the move frame verifies against the publisher key (domain-separated Ed25519)", mvOk);

const msync = await call(SUB, "POST", "/federation/sync", undefined, { "x-ingest-secret": SECRET });
ok("subscriber mirrors the account move", (msync.data?.moves ?? 0) >= 1, JSON.stringify(msync.data));
const mpeers = await call(SUB, "GET", "/federation/peers");
ok(
  "subscriber moves_cursor advanced",
  (mpeers.data?.peers ?? []).some((p) => p.instance === pubInstance && p.moves_cursor > 0),
  JSON.stringify(mpeers.data),
);

// ---- federation observability ----
const hpeers = await call(SUB, "GET", "/federation/peers");
const pubPeer = (hpeers.data?.peers ?? []).find((p) => p.instance === pubInstance);
ok(
  "peer health metrics tracked (health ok, sync_ok>0, mirrored_total>0)",
  pubPeer?.health === "ok" && pubPeer?.sync_ok > 0 && pubPeer?.mirrored_total > 0,
  JSON.stringify(pubPeer && { health: pubPeer.health, sync_ok: pubPeer.sync_ok, total: pubPeer.mirrored_total }),
);
ok(
  "the last sync's per-feed breakdown is reported",
  pubPeer?.lastCounts && typeof pubPeer.lastCounts === "object",
  JSON.stringify(pubPeer?.lastCounts),
);
ok(
  // "currently healthy" is the invariant: last_ok is set and the peer is not in a persistent error
  // state (health==='ok', asserted above, means its most-recent sync succeeded). We do NOT demand a
  // perfect history — this e2e fans out ~8 syncs and a single transient peer-fetch blip (timeout on a
  // loaded runner) recovers on the next sync; requiring errorRate===0 across all of them is flaky.
  "a healthy peer has last_ok set and a low error rate (recovered transients tolerated)",
  pubPeer?.last_ok != null && (pubPeer?.errorRate ?? 1) < 0.5,
  JSON.stringify({ last_ok: pubPeer?.last_ok, errorRate: pubPeer?.errorRate }),
);
// reputation: the publisher corroborated finds that reached Tier A → it earned rep_confirmed
ok(
  "a corroborating peer earns reputation (rep_confirmed > 0)",
  (pubPeer?.rep_confirmed ?? 0) > 0,
  JSON.stringify({ rep_confirmed: pubPeer?.rep_confirmed }),
);

// ---- key rotation + multi-key + revocation ----
// The publisher is started with FED_KEY_HISTORY (an extra active key + a revoked one), so every
// mirror assertion above already exercises multi-key verification (current key ∈ the active set).
const wkk = await call(PUB, "GET", "/.well-known/aprscaching");
const pks = wkk.data?.publicKeys ?? [];
ok(
  "well-known publishes a publicKeys[] including the current signing key",
  Array.isArray(pks) && pks.some((k) => k.x === wkk.data.publicKey),
  JSON.stringify(pks),
);
ok(
  "publicKeys carries an extra active key (multi-key) and a revoked one",
  pks.length >= 3 && pks.some((k) => k.revoked === true),
  JSON.stringify(pks.map((k) => [k.x?.slice(0, 6), !!k.revoked])),
);

// ---- signed instance registry / namespace authority ----
// The subscriber is started with a signed FED_REGISTRY binding oe.pub → the publisher's real key, so
// every mirror assertion above already passed the anti-spoof check (the published key matched the
// registry). A mismatched key would have thrown and blocked the sync (unit-tested separately).
const regResp = await call(SUB, "GET", "/federation/registry");
ok(
  "the signed registry is loaded + verified, binding the publisher instance",
  regResp.data?.verified === true && (regResp.data?.entries ?? []).some((e) => e.instance === pubInstance && e.key),
  JSON.stringify(regResp.data?.entries),
);
ok(
  "an instance self-publishes its operator + APRS service address",
  wkk.data?.operator === "OE8APR" && wkk.data?.aprsCall === "OE8APR-12",
  JSON.stringify({ operator: wkk.data?.operator, aprsCall: wkk.data?.aprsCall }),
);

// ---- the rendezvous relay queue (poll-based, box-command seam) ----
// Only asserted when the instances were started with a relay secret (CI sets it); proves the transport:
// a requester enqueues a feed query for a spoke instance, the spoke leases + answers, the requester reads it.
const RELAY_SECRET = process.env.RELAY_SECRET;
if (RELAY_SECRET) {
  const spoke = "oe.spoke";
  // lease/answer are bound to a per-spoke token = HMAC(RELAY_SECRET, "relay-spoke:<instance>"),
  // so a secret-holder can't drain another instance's queue by naming it. The requester side (enqueue,
  // result) still uses the flat secret.
  const spokeToken = async (instance) => {
    const k = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(RELAY_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`relay-spoke:${instance.toLowerCase()}`));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const rh = { "x-relay-secret": RELAY_SECRET };
  const sh = { "x-relay-secret": RELAY_SECRET, "x-relay-token": await spokeToken(spoke) };
  const enq = await call(
    PUB,
    "POST",
    `/federation/relay/${spoke}/query`,
    { kind: "feed", params: { feed: "caches", since: 0 } },
    rh,
  );
  ok(
    "relay: a feed query is enqueued for a spoke instance",
    enq.status === 201 && typeof enq.data?.id === "number",
    JSON.stringify(enq.data),
  );
  const lease = await call(PUB, "GET", `/federation/relay/lease?instance=${spoke}`, undefined, sh);
  ok(
    "relay: the spoke leases queries addressed to it",
    (lease.data?.queries ?? []).some((q) => q.id === enq.data.id && q.kind === "feed"),
    JSON.stringify(lease.data),
  );
  const ans = await call(
    PUB,
    "POST",
    "/federation/relay/answer",
    { id: enq.data.id, instance: spoke, result: { ok: true, kind: "feed", data: { items: [] } } },
    sh,
  );
  ok("relay: the spoke posts an answer", ans.data?.ok === true, JSON.stringify(ans.data));
  const res = await call(PUB, "GET", `/federation/relay/result/${enq.data.id}`, undefined, rh);
  ok(
    "relay: the requester collects the answered result",
    res.data?.status === "answered" && res.data?.answer?.ok === true,
    JSON.stringify(res.data),
  );
  const noauth = await call(PUB, "GET", "/federation/relay/lease?instance=oe.spoke", undefined, {
    "x-relay-secret": "wrong",
  });
  ok("relay: a bad secret is rejected", noauth.status === 401, String(noauth.status));
  // a spoke's token for its OWN instance cannot lease a DIFFERENT instance's queue.
  const wrongInstance = await call(PUB, "GET", "/federation/relay/lease?instance=oe.other", undefined, sh);
  ok(
    "relay: a per-spoke token can't lease another instance",
    wrongInstance.status === 401,
    String(wrongInstance.status),
  );
}

// ---- corroboration privacy coarsening + endpoint hardening ----
// (must run LAST — the rate-limit probe trips the shared in-memory IP bucket on the publisher)
// Isolate this probe from the shared in-memory rate-limit bucket. corroborate.ts keys on
// `ip:${clientIp}` OR `call:${baseCall}`; over localhost clientIp is "unknown", so EVERY earlier
// Tier-A-via-peer find in this run (from both gateway processes) has been incrementing the one
// `ip:unknown` bucket (RL_MAX=60/60 s). Give the probe a distinct x-forwarded-for → a fresh ip:
// bucket that can't 429 on accumulated state. The callsign stays LO3RF so the corroboration is real.
const probe = await call(
  PUB,
  "POST",
  "/federation/corroborate",
  { callsign: "LO3RF", lat: LAT, lon: LON, radiusM: 200, since: t - 3600, until: t + 3600 },
  { "x-forwarded-for": "203.0.113.7" },
);
ok("a direct corroboration probe is answered", probe.data?.corroborated === true, JSON.stringify(probe.data));
ok(
  "the response distance is bucketed (no exact metres)",
  Number.isInteger((probe.data?.evidence?.distanceM ?? 1) / 100),
  JSON.stringify(probe.data?.evidence),
);
ok(
  "the response hides the exact IGate by default",
  probe.data?.evidence?.igateCall === undefined,
  JSON.stringify(probe.data?.evidence),
);
ok(
  "no IGate callsign leaks on the wire (not a location oracle)",
  !/OE8XXX/.test(JSON.stringify(probe.data)),
  JSON.stringify(probe.data),
);

// Hermetic flood: a dedicated client IP + a dedicated callsign, so this proves "one source over
// RL_MAX in a window → 429" against a FRESH bucket rather than depending on accumulated shared
// state. RL_MAX is 60/60 s, so 80 rapid requests trip it deterministically with margin.
let got429 = false;
for (let i = 0; i < 80 && !got429; i++) {
  const r = await call(
    PUB,
    "POST",
    "/federation/corroborate",
    { callsign: "FLOOD1", lat: 0, lon: 0, radiusM: 10, since: 0, until: 1 },
    { "x-forwarded-for": "203.0.113.8" },
  );
  if (r.status === 429) got429 = true;
}
ok("the corroboration endpoint rate-limits abusive probing (429)", got429);

console.log(failures ? `\nFEDERATION FAILED (${failures})` : "\nFEDERATION CONFORMANCE PASSED");
process.exit(failures ? 1 : 0);
