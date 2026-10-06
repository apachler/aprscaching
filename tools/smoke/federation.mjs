// SPDX-License-Identifier: AGPL-3.0-or-later
// Two-instance federation conformance: a PUBLISHER and a SUBSCRIBER, both already running.
// Seeds the publisher, triggers a pull-sync on the subscriber, and asserts the subscriber mirrored
// the publisher's (signature-verified) cache onto its own map.
//
//   PUB=http://127.0.0.1:8801 SUB=http://127.0.0.1:8802 node tools/smoke/federation.mjs

import { createHash } from "node:crypto";
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
// operator-level calls (sync trigger, peer trust) take OPERATOR_SECRET, never the ingest secret
const OPERATOR_SECRET = process.env.OPERATOR_SECRET ?? "";
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

// the CBOR sync surface serves fedwire frames: application/cbor, page envelope = map(4), or map(5)
// when the feed's cursor is composite and the page carries its id tie-breaker
{
  const res = await fetch(PUB + "/federation/sync/cache?since=0");
  const bytes = new Uint8Array(await res.arrayBuffer());
  ok(
    "GET /federation/sync/cache serves a CBOR page",
    res.status === 200 &&
      (res.headers.get("content-type") ?? "").includes("application/cbor") &&
      (bytes[0] === 0xa4 || bytes[0] === 0xa5),
    `status=${res.status} ct=${res.headers.get("content-type")} b0=${bytes[0]?.toString(16)}`,
  );
}

// Quiesce before seeding: the subscriber kicks a federation sync at boot (the node/bun servers run
// `runScheduled` once on listen), so a pull can already be in flight here. The counts an explicit
// /federation/sync reports describe ITS OWN pull, and a pull that started before the seed below
// cannot contain it — awaiting one sync now leaves nothing in flight, and the periodic interval is
// five minutes away. Without this the assertions below race the boot sync.
await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });

// seed the publisher: a cache + a find
const TITLE = "Federated Schlossberg " + now();
const created = await call(PUB, "POST", "/api/caches", {
  title: TITLE,
  type: "traditional",
  lat: 47.0735,
  lon: 15.4378,
  difficulty: 2,
  terrain: 2,
  ownerCall: "OE8APR",
});
ok("publisher created a cache", created.status === 201, JSON.stringify(created.data));
const pid = created.data?.cache?.id;
await call(PUB, "POST", `/api/caches/${pid}/logs`, { loggerCall: "DL1ABC", logType: "found" });

// trigger a pull-sync on the subscriber
const sync = await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });
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
// the key the subscriber pinned has the fingerprint the publisher reports as its own
{
  const own = (await call(PUB, "GET", "/federation/peers")).data?.self?.fingerprint;
  const pinned = (peers.data?.peers ?? []).find((p) => p.instance === pubInstance)?.fingerprint;
  ok(
    "the pinned key's fingerprint matches the publisher's own",
    /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/.test(pinned ?? "") && pinned === own,
    `pinned=${pinned} own=${own}`,
  );
}

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
const sync2 = await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });
ok("re-sync is clean", sync2.data?.ok === true && (sync2.data?.errors ?? []).length === 0);
const list2 = await call(SUB, "GET", "/api/caches?bbox=15,46,16,48");
ok("no duplicate mirror after re-sync", (list2.data?.caches ?? []).filter((c) => c.title === TITLE).length === 1);

// auth: sync requires the operator secret (the call() default is overridden with an invalid one)
const badOperatorSync = await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": "" });
ok("sync with an invalid secret -> 401", badOperatorSync.status === 401, `status=${badOperatorSync.status}`);

// ---- cross-instance verification (the network effect) ----
// The logger's RF position is heard only by the PUBLISHER's attested site OE8XXX, directly on its own
// TNC (independent of the logger) — an APRS-IS copy naming that site would not count.
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
        path: ["WIDE1-1"],
        payload: "=4712.00N/01503.00E>",
        kind: "position",
        parsed: { lat: LAT + 0.0005, lon: LON, symbol: ">" },
        heardVia: "rf",
        igateCall: "OE8XXX",
        port: "kiss-tnc",
        ts: t,
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);

const sCache = await call(SUB, "POST", "/api/caches", {
  title: "Peer-Verified Summit " + t,
  type: "traditional",
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

// a device key binds only through the holder's own session (email sign-in with a dev token)
async function signUp(base, cs) {
  const st = await call(base, "POST", "/auth/email/start", {
    email: `${cs.toLowerCase()}+${now()}@example.test`,
    callsign: cs,
  });
  const vr = await fetch(base + "/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: st.data?.devToken }),
  });
  return (/(acs=[^;]+)/.exec(vr.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
}
const reg = await call(
  PUB,
  "POST",
  "/keys/register",
  { callsign: "OE8APR", publicKey: pubRaw, label: "device" },
  { cookie: await signUp(PUB, "OE8APR") },
);
ok("key registration accepted", reg.data?.ok === true && reg.data?.publicKey === pubRaw, JSON.stringify(reg.data));

const sc = await call(PUB, "POST", "/api/caches", {
  title: "Signed Find " + now(),
  type: "traditional",
  lat: 47.08,
  lon: 15.41,
  ownerCall: "OE8SFO", // not the finder: an owner does not find their own cache
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

const syncK = await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });
ok("subscriber mirrors keys", (syncK.data?.keys ?? 0) >= 1, JSON.stringify(syncK.data));
const peers2 = await call(SUB, "GET", "/federation/peers");
ok(
  "subscriber keys_cursor advanced",
  (peers2.data?.peers ?? []).some((p) => p.instance === pubInstance && p.keys_cursor > 0),
  JSON.stringify(peers2.data),
);

// ---- peer trust tiers + quarantine ----
// The subscriber's only peer is the publisher, listed in FED_PEERS with its key fingerprint pinned → it
// starts trusted once its key matches, and stays manual.
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
  { "x-operator-secret": "" },
);
ok("trust change without the operator secret -> 401", t401.status === 401, `status=${t401.status}`);
const t400 = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "bogus" },
  { "x-operator-secret": OPERATOR_SECRET },
);
ok("an invalid trust level -> 400", t400.status === 400, `status=${t400.status}`);
const t404 = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: "http://127.0.0.1:9", trust: "trusted" },
  { "x-operator-secret": OPERATOR_SECRET },
);
ok("an unknown peer -> 404", t404.status === 404, `status=${t404.status}`);

// quarantine: block the only peer → a fresh find can no longer reach Tier A (empty trusted pool)
const blk = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "blocked" },
  { "x-operator-secret": OPERATOR_SECRET },
);
ok("operator blocked the peer", blk.data?.ok === true && blk.data?.trust === "blocked", JSON.stringify(blk.data));
const bCache = await call(SUB, "POST", "/api/caches", {
  title: "Blocked-Peer Summit " + now(),
  type: "traditional",
  lat: LAT,
  lon: LON,
  ownerCall: "OE8SUB",
});
const blockedLog = await call(SUB, "POST", `/api/caches/${bCache.data?.cache?.id}/logs`, {
  loggerCall: "LO3RF",
  logType: "found",
});
ok("a blocked peer cannot grant Tier A", blockedLog.data?.tier !== "A", JSON.stringify(blockedLog.data));
const blkSync = await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });
ok(
  "a blocked peer is skipped on sync (no fetch, no error)",
  blkSync.data?.ok === true && (blkSync.data?.errors ?? []).length === 0,
  JSON.stringify(blkSync.data),
);

// promote back to trusted → corroboration is restored, and approval is stamped
const bare = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "trusted" },
  { "x-operator-secret": OPERATOR_SECRET },
);
ok("trusting a peer without the compared fingerprint -> 400", bare.status === 400, `status=${bare.status}`);
const prom = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "trusted", fingerprint: peerRec.fingerprint },
  { "x-operator-secret": OPERATOR_SECRET },
);
ok(
  "operator promoted the peer to trusted",
  prom.data?.ok === true && prom.data?.trust === "trusted",
  JSON.stringify(prom.data),
);
const rCache = await call(SUB, "POST", "/api/caches", {
  title: "Re-trusted Summit " + now(),
  type: "traditional",
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
await call(
  PUB,
  "POST",
  "/keys/register",
  { callsign: "TOMB1", publicKey: tpub, label: "device" },
  { cookie: await signUp(PUB, "TOMB1") },
);

// TOMB1 owns a cache and logs a find on the publisher
const T_TITLE = "Tombstone Cache " + now();
const tCache = await call(PUB, "POST", "/api/caches", {
  title: T_TITLE,
  type: "traditional",
  lat: 48.21,
  lon: 16.37,
  ownerCall: "TOMB1",
});
// TOMB1's find goes on another owner's cache: an owner does not find their own
const tFound = await call(PUB, "POST", "/api/caches", {
  title: "Tombstone Find " + now(),
  type: "traditional",
  lat: 48.22,
  lon: 16.38,
  ownerCall: "OE8TFO",
});
const tLog = await call(PUB, "POST", `/api/caches/${tFound.data?.cache?.id}/logs`, {
  loggerCall: "TOMB1",
  logType: "found",
});
ok(
  "publisher created a TOMB1-owned cache + a TOMB1 find",
  tCache.status === 201 && tLog.status === 200,
  JSON.stringify({ cache: tCache.data, log: tLog.data }),
);

// subscriber mirrors it onto its map
const BBOXT = "16.2,48.0,16.6,48.4";
await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });
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
const tsync = await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });
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
await call(PUB, "POST", "/api/caches", {
  title: G_TITLE,
  type: "traditional",
  lat: 47.09,
  lon: 15.44,
  ownerCall: "OE8APR",
});
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
  type: "traditional",
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
// a shared submit secret is not an identity: the new spoke enters unvetted (hidden from the default
// map) until the operator promotes it
const spokeRow = (await call(SUB, "GET", "/federation/peers")).data?.peers?.find((p) => p.url === "submit:oe.spoke");
ok("a new spoke is registered unvetted", spokeRow?.trust === "unvetted", JSON.stringify(spokeRow?.trust));
const hidden = await call(SUB, "GET", "/api/caches?bbox=15.5,47,16.5,48");
ok(
  "an unvetted spoke's cache stays off the default map",
  !(hidden.data?.caches ?? []).some((c) => c.origin === "oe.spoke"),
  JSON.stringify((hidden.data?.caches ?? []).map((c) => c.origin)),
);
const promote = await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: "submit:oe.spoke", trust: "trusted", fingerprint: spokeRow?.fingerprint },
  { "x-operator-secret": OPERATOR_SECRET },
);
ok("the operator promotes the spoke", promote.status === 200, `status=${promote.status}`);
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
// alongside the forgery, a genuine new record (a second cache): the page applies it and rejects only
// the forgery (re-sending spokeFrame would itself be refused, as a version already applied)
const spokeFrame2 = await buildFrame(
  { kind: 1, gid: "oe.spoke:cache:2", origin: "oe.spoke", v: now(), at: now(), signer: "oe.spoke", body: spokeBody },
  skp.privateKey,
  spub,
);
const sub2 = await submitCbor(SUB, encodePage("oe.spoke", now(), true, [spokeFrame2, forged]));
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
await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "unvetted" },
  { "x-operator-secret": OPERATOR_SECRET },
);
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
await call(
  SUB,
  "POST",
  "/federation/peers/trust",
  { url: PUB, trust: "trusted", fingerprint: peerRec.fingerprint },
  { "x-operator-secret": OPERATOR_SECRET },
);
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
    type: "traditional",
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
// an unlisted cache stays off the maps: its origin's (for anyone but the owner) and every mirror's
const pubMap = await call(PUB, "GET", "/api/caches?bbox=15,46,16,48");
ok(
  "an unlisted cache is off its origin's public map",
  !(pubMap.data?.caches ?? []).some((c) => c.title === cUnl.data?.cache?.title),
  `status=${pubMap.status}`,
);
await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });
const scopeMap = (await call(SUB, "GET", "/api/caches?bbox=15,46,16,48")).data?.caches ?? [];
ok(
  "a mirror shows the public cache and keeps the unlisted one off its map",
  scopeMap.some((c) => c.title === cPub.data?.cache?.title) &&
    !scopeMap.some((c) => c.title === cUnl.data?.cache?.title),
  scopeMap.map((c) => c.title).join(","),
);

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

// a mirror keeps a move only under a key it knows for the callsign independently of the instance
// claiming the move — here the mover registered the same device key on the subscriber
await call(
  SUB,
  "POST",
  "/keys/register",
  { callsign: "OE7MOV", publicKey: mpub, label: "dev" },
  { cookie: await signUp(SUB, "OE7MOV") },
);
const msync = await call(SUB, "POST", "/federation/sync", undefined, { "x-operator-secret": OPERATOR_SECRET });
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
// Only asserted when the hub was started with a relay secret (CI sets it on SUB); proves the transport:
// a requester enqueues a feed query for a spoke instance, the spoke leases + answers, the requester
// reads it with its ticket. The spoke is oe.spoke, whose key SUB already holds from the push-to-hub
// submission above: lease and answer are signed with that key, so a spoke can act only for itself.
const RELAY_SECRET = process.env.RELAY_SECRET;
if (RELAY_SECRET) {
  const spoke = "oe.spoke";
  const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  /** Headers signing one relay request as `instance` with `priv`: method, path+query, time, body hash. */
  const spokeSig = async (instance, priv, method, path, body = "") => {
    const at = now();
    const bodyHash = hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
    const msg = new TextEncoder().encode(`acs-relay/1\n${method} ${path}\n${at}\n${bodyHash}`);
    const sig = b64u(await crypto.subtle.sign("Ed25519", priv, msg));
    return { "x-relay-instance": instance, "x-relay-at": String(at), "x-relay-sig": sig };
  };
  const rh = { "x-relay-secret": RELAY_SECRET };
  const enq = await call(
    SUB,
    "POST",
    `/federation/relay/${spoke}/query`,
    { kind: "feed", params: { feed: "caches", since: 0 } },
    rh,
  );
  ok(
    "relay: a feed query is enqueued for a spoke instance",
    enq.status === 201 && typeof enq.data?.id === "number" && typeof enq.data?.ticket === "string",
    JSON.stringify(enq.data),
  );
  const leasePath = `/federation/relay/lease?instance=${spoke}`;
  const lease = await call(SUB, "GET", leasePath, undefined, await spokeSig(spoke, skp.privateKey, "GET", leasePath));
  ok(
    "relay: the spoke leases queries addressed to it",
    (lease.data?.queries ?? []).some((q) => q.id === enq.data.id && q.kind === "feed"),
    JSON.stringify(lease.data),
  );
  const answerBody = { id: enq.data.id, instance: spoke, result: { ok: true, kind: "feed", data: { items: [] } } };
  const ans = await call(
    SUB,
    "POST",
    "/federation/relay/answer",
    answerBody,
    await spokeSig(spoke, skp.privateKey, "POST", "/federation/relay/answer", JSON.stringify(answerBody)),
  );
  ok("relay: the spoke posts an answer", ans.data?.ok === true, JSON.stringify(ans.data));
  const others = await call(SUB, "GET", `/federation/relay/result/${enq.data.id}`, undefined, rh);
  ok("relay: a result is not readable without its ticket", others.status === 403, String(others.status));
  const res = await call(SUB, "GET", `/federation/relay/result/${enq.data.id}`, undefined, {
    ...rh,
    "x-relay-ticket": enq.data.ticket,
  });
  ok(
    "relay: the requester collects the answered result",
    res.data?.status === "answered" && res.data?.answer?.ok === true,
    JSON.stringify(res.data),
  );
  const unsigned = await call(SUB, "GET", leasePath, undefined, rh);
  ok("relay: an unsigned lease is rejected", unsigned.status === 401, String(unsigned.status));
  // the spoke's own key cannot lease a DIFFERENT instance's queue
  const otherPath = "/federation/relay/lease?instance=oe.other";
  const wrongInstance = await call(
    SUB,
    "GET",
    otherPath,
    undefined,
    await spokeSig("oe.other", skp.privateKey, "GET", otherPath),
  );
  ok("relay: a spoke's key can't lease another instance", wrongInstance.status === 401, String(wrongInstance.status));
}

// ---- corroboration: a signed exchange, coarsened answers, rate limits ----
// (must run LAST — the rate-limit probe exhausts this asker's budget on the publisher)
// A corroboration question is a signed fedwire frame (type 10) with a fresh nonce; the answer is a
// signed frame (type 11) bound to that nonce. This probe asks as an anonymous key — the publisher
// does not require known askers — so the whole exchange is exercised end to end.
const akp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const apub = b64u(await crypto.subtle.exportKey("raw", akp.publicKey));
const ask = (callsign, nonce, win) =>
  buildFrame(
    {
      kind: 10,
      gid: `smoke.asker:corroborationQuery:${nonce}`,
      origin: "smoke.asker",
      v: now(),
      at: now(),
      signer: "smoke.asker",
      body: {
        callsign,
        latE7: Math.round(LAT * 1e7),
        lonE7: Math.round(LON * 1e7),
        radiusM: 200,
        since: win.since,
        until: win.until,
        nonce,
        target: pubInstance,
      },
    },
    akp.privateKey,
    apub,
  );
const postQuestion = (frame) =>
  fetch(PUB + "/federation/corroborate", {
    method: "POST",
    headers: { "content-type": "application/cbor" },
    body: frame,
  });

const unsignedProbe = await call(PUB, "POST", "/federation/corroborate", {
  callsign: "LO3RF",
  lat: LAT,
  lon: LON,
  radiusM: 200,
  since: t - 1800,
  until: now(),
});
ok("an unsigned JSON question is refused (415)", unsignedProbe.status === 415, `status=${unsignedProbe.status}`);

const probeRes = await postQuestion(await ask("LO3RF", "5a0e", { since: t - 1800, until: now() }));
let answer = null;
try {
  const parts = frameParts(new Uint8Array(await probeRes.arrayBuffer()));
  const rec = miniDecode(parts.payload);
  answer = { type: rec.get(1), origin: rec.get(3), body: Object.fromEntries(rec.get(7)) };
} catch {}
ok(
  "a signed question gets a signed corroboration answer",
  probeRes.status === 200 && answer?.type === 11 && answer?.body?.corroborated === true,
  `status=${probeRes.status} ${JSON.stringify(answer)}`,
);
ok("the answer echoes the question's nonce", answer?.body?.nonce === "5a0e", JSON.stringify(answer?.body));
ok(
  "the answer distance is bucketed (no exact metres)",
  Number.isInteger((answer?.body?.distanceCm ?? 1) / 10000),
  JSON.stringify(answer?.body),
);
ok("the answer hides the exact IGate by default", answer?.body?.igateCall === undefined, JSON.stringify(answer?.body));
ok(
  "no IGate callsign leaks on the wire (not a location oracle)",
  !/OE8XXX/.test(JSON.stringify(answer)),
  JSON.stringify(answer),
);

// An APRS-IS line naming the attested site (`qAR,OE8XXX`) is something anyone with a public passcode can
// inject, so it vouches for nothing.
await call(
  PUB,
  "POST",
  "/ingest",
  {
    packets: [
      {
        src: "LO3IS",
        path: ["WIDE1-1", "qAR", "OE8XXX"],
        payload: "=4712.00N/01503.00E>",
        kind: "position",
        parsed: { lat: LAT + 0.0005, lon: LON, symbol: ">" },
        heardVia: "rf",
        igateCall: "OE8XXX",
        port: "aprs-is",
        ts: now(),
      },
    ],
  },
  { "x-ingest-secret": SECRET },
);
const isProbe = await postQuestion(await ask("LO3IS", "15c0", { since: now() - 1800, until: now() }));
let isAnswer = null;
try {
  const parts = frameParts(new Uint8Array(await isProbe.arrayBuffer()));
  isAnswer = Object.fromEntries(miniDecode(parts.payload).get(7));
} catch {}
ok(
  "an APRS-IS qAR copy naming the attested site does not corroborate",
  isProbe.status === 200 && isAnswer?.corroborated === false,
  `status=${isProbe.status} ${JSON.stringify(isAnswer)}`,
);

// Flood from one asker: RL_MAX is 60/60 s, so 80 rapid signed questions trip it deterministically.
let got429 = false;
for (let i = 0; i < 80 && !got429; i++) {
  const r = await postQuestion(await ask("FLOOD1", `f${i}`, { since: now() - 600, until: now() }));
  if (r.status === 429) got429 = true;
}
ok("the corroboration endpoint rate-limits abusive probing (429)", got429);

// ---- adding and removing a peer by address (Instance admin) ----
{
  const OPH = { "x-operator-secret": OPERATOR_SECRET };
  const subWk = await call(SUB, "GET", "/.well-known/aprscaching");
  const subFp = createHash("sha256")
    .update(Buffer.from(subWk.data?.publicKey ?? "", "base64url"))
    .digest("hex")
    .slice(0, 16)
    .replace(/(.{4})(?=.)/g, "$1 ");
  const look = await call(PUB, "POST", "/federation/peers", { url: SUB }, OPH);
  ok(
    "looking a peer up by address shows its instance and key fingerprint",
    look.status === 200 &&
      look.data?.preview?.instance === subWk.data?.instance &&
      look.data?.preview?.fingerprint === subFp,
    JSON.stringify(look.data),
  );
  const added = await call(PUB, "POST", "/federation/peers", { url: SUB, fingerprint: subFp }, OPH);
  ok(
    "a peer added by address starts unvetted",
    added.status === 201 && added.data?.peer?.trust === "unvetted",
    JSON.stringify(added.data),
  );

  // ---- a hub passes its spokes' records on: oe.spoke → SUB (the hub) → PUB, which never peers with oe.spoke ----
  const transitOf = async (query) => {
    const res = await fetch(`${SUB}/federation/sync/transit?since=0${query}`);
    return res.ok ? decodePage(new Uint8Array(await res.arrayBuffer())) : null;
  };
  const spokeFrames = (pg) =>
    (pg?.frames ?? []).filter((f) => String(miniDecode(frameParts(f).payload).get(3)) === "oe.spoke");
  const tpage = await transitOf("");
  const passed = spokeFrames(tpage);
  ok(
    "the hub passes on its trusted spoke's records, as the spoke signed them",
    passed.length > 0 &&
      passed.every((f) => frameParts(f).signerKey === spub) &&
      passed.some((f) => Buffer.from(f).equals(Buffer.from(spokeFrame))) &&
      Array.isArray(tpage?.hops) &&
      tpage.hops.length === tpage.frames.length,
    JSON.stringify({ n: passed.length, hops: tpage?.hops }),
  );
  ok("nothing goes back to the spoke it came from", spokeFrames(await transitOf("&for=oe.spoke")).length === 0);
  const tkeys = await call(SUB, "GET", "/federation/transit/keys");
  ok(
    "the hub hands on the spoke's key",
    (tkeys.data?.keys ?? []).some((k) => k.instance === "oe.spoke" && k.publicKey === spub),
    JSON.stringify(tkeys.data),
  );
  await call(PUB, "POST", "/federation/sync", undefined, OPH);
  const learned = (await call(PUB, "GET", "/federation/peers", undefined, OPH)).data?.peers?.find(
    (p) => p.instance === "oe.spoke",
  );
  ok(
    "the third instance learns the spoke's key through the hub, unvetted",
    learned?.url === "transit:oe.spoke" && learned?.trust === "unvetted" && learned?.added_via === "transit",
    JSON.stringify(learned),
  );
  const box = "/api/caches?bbox=15.5,47,16.5,48";
  const pubDefault = await call(PUB, "GET", box);
  const pubAll = await call(PUB, "GET", `${box}&includeUnvetted=1`);
  ok(
    "the spoke's cache reaches the third instance under the spoke's own trust there (hidden until included)",
    !(pubDefault.data?.caches ?? []).some((c) => c.origin === "oe.spoke") &&
      (pubAll.data?.caches ?? []).some((c) => c.origin === "oe.spoke" && c.originTrust === "unvetted"),
    JSON.stringify((pubAll.data?.caches ?? []).map((c) => [c.origin, c.originTrust])),
  );
  const raised = await call(
    PUB,
    "POST",
    "/federation/peers/trust",
    { url: SUB, trust: "trusted", fingerprint: subFp },
    OPH,
  );
  ok(
    "trusting it is a separate step, with the compared fingerprint",
    raised.data?.trust === "trusted",
    JSON.stringify(raised.data),
  );
  const removed = await call(PUB, "DELETE", `/federation/peers?url=${encodeURIComponent(SUB)}`, undefined, OPH);
  const after = await call(PUB, "GET", "/federation/peers", undefined, OPH);
  ok(
    "removing a peer deletes it",
    removed.status === 200 && !(after.data?.peers ?? []).some((p) => p.url === SUB),
    JSON.stringify(removed.data),
  );
  const back = await call(PUB, "POST", "/federation/peers", { url: SUB, fingerprint: subFp }, OPH);
  ok(
    "a removed peer added again starts unvetted",
    back.status === 201 && back.data?.peer?.trust === "unvetted",
    JSON.stringify(back.data),
  );
  await call(PUB, "DELETE", `/federation/peers?url=${encodeURIComponent(SUB)}`, undefined, OPH);
  const envListed = await call(SUB, "DELETE", `/federation/peers?url=${encodeURIComponent(PUB)}`, undefined, OPH);
  ok("a peer FED_PEERS lists is not removed here -> 409", envListed.status === 409, `status=${envListed.status}`);
}

console.log(failures ? `\nFEDERATION FAILED (${failures})` : "\nFEDERATION CONFORMANCE PASSED");
process.exit(failures ? 1 : 0);
