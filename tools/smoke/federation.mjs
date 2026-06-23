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
    method, headers: { "content-type": "application/json", ...headers },
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

// auth: sync requires the ingest secret
const noauth = await call(SUB, "POST", "/federation/sync");
ok("sync without secret -> 401", noauth.status === 401, `status=${noauth.status}`);

console.log(failures ? `\nFEDERATION FAILED (${failures})` : "\nFEDERATION CONFORMANCE PASSED");
process.exit(failures ? 1 : 0);
