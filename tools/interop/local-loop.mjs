// SPDX-License-Identifier: AGPL-3.0-or-later
// Two full APRScaching stacks (gateway + ingest) crosslinked over AXUDP — the interop
// environment's smallest end-to-end: NET/ROM NODES broadcasts learned in both directions, an
// FBB forwarding session (our scheduler dialling our SID-gated BBS responder) carrying a message
// A→B over real AX.25 connected mode on the UDP wire, and A's ingest pulling B's signed federation
// feed over an AX.25 circuit to B's ingest. No Docker, no kernel AX.25 — the same code
// paths a BPQ/FBB peer will exercise in the compose environment.
//
//   A=http://127.0.0.1:9601 B=http://127.0.0.1:9602 node tools/interop/local-loop.mjs

import { boxFetch, enrollBox } from "../smoke/boxsign.mjs";

const A = process.env.A ?? "http://127.0.0.1:9601";
const B = process.env.B ?? "http://127.0.0.1:9602";
const SECRET = process.env.INGEST_SECRET ?? "change-me";
// forwarding partners and rules are operator configuration: they take OPERATOR_SECRET
const OPERATOR_SECRET = process.env.OPERATOR_SECRET ?? "";
let failures = 0;

function ok(name, cond, detail = "") {
  const pass = !!cond;
  console.log(`${pass ? "OK " : "FAIL"} ${name}${pass ? "" : `  -- ${detail}`}`);
  if (!pass) failures++;
}

async function call(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-ingest-secret": SECRET,
      "x-operator-secret": OPERATOR_SECRET,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probes = new Map();
/**
 * One request to the BBS at `base` as its packet BBS box would send it: signed by "loop-probe", a box enrolled
 * with its own key that the sysop lets run the instance's services. The mailboxes and the FBB forwarding queue
 * take only such a box; the shared ingest secret runs no BBS.
 */
async function bbs(base, method, path, body) {
  if (!probes.has(base)) {
    const r = await enrollBox(base, OPERATOR_SECRET, "loop-probe");
    const s = r.error ? null : await call(base, "POST", "/api/admin/boxes/loop-probe/services", { services: true });
    if (r.error || s.status !== 200) {
      console.error(`FAIL the probe box could not be enrolled on ${base}: ${r.error ?? JSON.stringify(s.data)}`);
      process.exit(1);
    }
    probes.set(base, r.key);
  }
  return boxFetch(base, probes.get(base), method, path, body);
}

/**
 * A session for `cs`, the ADMIN_CALLSIGNS call of the gateway at `base`, opened with the operator's sign-in
 * link and verified with the operator secret, the way `pnpm dev:admin` does. Returns the cookie, or "".
 * A cache is hidden by a signed-in, control-verified call: the ingest secret hides none.
 */
async function operatorSession(base, cs) {
  const link = await call(base, "POST", "/auth/operator-link", { callsign: cs });
  const token = link.data?.link ? new URL(link.data.link).searchParams.get("token") : null;
  if (!token) return "";
  const vr = await fetch(base + "/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const cookie = (/(acs=[^;]+)/.exec(vr.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
  const verified = await call(base, "POST", "/verify/operator", { callsign: cs });
  return verified.status === 200 ? cookie : "";
}

/** Poll until `check` returns truthy or the deadline passes; returns the last value. */
async function until(label, deadlineMs, check) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > deadlineMs) return null;
    await sleep(1000);
  }
}

// ---- partner + routing config on A: everything @...OE... forwards to B's BBS callsign ----
const addPartner = await call(A, "POST", "/api/bbs/partners", {
  call: "OE1BBB-1",
  ha: "OE1BBB.OE.EU",
  proto: "rf-fbb",
  requestReverse: true,
  enabled: true,
});
ok(
  "A: partner OE1BBB-1 configured",
  addPartner.status === 200 || addPartner.status === 201,
  JSON.stringify(addPartner),
);
const addRule = await call(A, "POST", "/api/bbs/forward", { partner: "OE1BBB-1", route: "OE", transport: "rf-fbb" });
ok("A: route OE -> OE1BBB-1", addRule.status === 201, JSON.stringify(addRule.data));

// Only mail from a control-verified call is forwarded over FBB; the sysop's own call is verified by the operator.
const verified = await call(A, "POST", "/verify/operator", { callsign: "OE1AAA" });
ok("A: sysop call OE1AAA verified", verified.data?.verified === true, JSON.stringify(verified.data));

// ---- post the message that must travel A -> B over the AXUDP AX.25 link ----
const post = await bbs(A, "POST", "/api/bbs/messages", {
  fromCall: "OE1AAA",
  toCall: "OE1TST @ OE1BBB.OE.EU",
  subject: "interop loop",
  body: "carried over AXUDP by the FBB forwarder",
});
ok("A: message posted", post.status === 201 || post.data?.id > 0, JSON.stringify(post.data));

const pool = await bbs(A, "GET", "/api/bbs/forward/pool?partner=OE1BBB-1");
ok("A: message sits in the OE1BBB-1 pool", (pool.data?.messages ?? []).length === 1, JSON.stringify(pool.data));

// ---- NODES: each side learns the other's alias from broadcasts on the AXUDP wire ----
const aSeesB = await until("A learns ACSB", 30000, async () => {
  const r = await call(A, "GET", "/api/node/nodes");
  return (r.data?.nodes ?? []).some((n) => n.alias === "ACSB");
});
ok("A: NODES table learned ACSB (B's alias) from broadcasts", !!aSeesB);
const bSeesA = await until("B learns ACSA", 30000, async () => {
  const r = await call(B, "GET", "/api/node/nodes");
  return (r.data?.nodes ?? []).some((n) => n.alias === "ACSA");
});
ok("B: NODES table learned ACSA (A's alias) from broadcasts", !!bSeesA);

// ---- the forwarding session: A's scheduler dials OE1BBB-1, B's SID gate answers ----
const delivered = await until("forwarded message lands on B", 90000, async () => {
  const r = await bbs(B, "GET", "/api/bbs/messages?to=OE1TST");
  return (r.data?.messages ?? []).find((m) => m.subject === "interop loop");
});
ok("B: forwarded message arrived over the AX.25/AXUDP session", !!delivered, JSON.stringify(delivered));
if (delivered) ok("B: arrival is marked as RF-FBB origin", /rf-fbb/.test(delivered.origin ?? ""), delivered.origin);

// ---- idempotency: the BID must not forward twice ----
const drained = await until("A's pool drains", 30000, async () => {
  const r = await bbs(A, "GET", "/api/bbs/forward/pool?partner=OE1BBB-1");
  return (r.data?.messages ?? []).length === 0;
});
ok("A: pool drained after the session (BID logged, no re-forward)", !!drained);

// ---- federation over FBB: off unless FED_BBS=1, and then only with the partner marked for it ----
if (process.env.FED_BBS === "1") {
  // each side marks the other for federation, after asking its sysop; A's next session follows a minute after
  // the first
  const markA = await call(A, "POST", "/api/bbs/partners", {
    call: "OE1BBB-1",
    ha: "OE1BBB.OE.EU",
    proto: "rf-fbb",
    intervalMin: 1,
    requestReverse: true,
    enabled: true,
    federation: true,
  });
  ok("A: partner OE1BBB-1 marked for federation", markA.data?.partner?.federation === true, JSON.stringify(markA));
  // B's BBS knows A's dial-in only by its AX.25 call; the partner row matches it by base call
  const markB = await call(B, "POST", "/api/bbs/partners", { call: "OE1AAA-1", intervalMin: 0, federation: true });
  ok("B: partner OE1AAA-1 marked for federation", markB.data?.partner?.federation === true, JSON.stringify(markB));

  // a local bulletin gives A's feed a record to sign
  await bbs(A, "POST", "/api/bbs/messages", { fromCall: "OE1AAA", toCall: "ALL", type: "B", body: "federated" });
  const enq = await call(A, "POST", "/federation/bbs/enqueue", { types: ["bulletin"] });
  ok("A: batch enqueued", enq.data?.enqueued === 1, JSON.stringify(enq.data));
  const offered = await bbs(A, "GET", "/api/bbs/forward/pool?partner=OE1BBB-1");
  ok(
    "A: the batch is offered to OE1BBB-1 as personal mail to ACSFED",
    (offered.data?.messages ?? []).some((m) => m.bid === enq.data?.bid && m.type === "P" && m.to === "ACSFED"),
    JSON.stringify(offered.data),
  );
  const landed = await until("the batch lands on B", 150000, async () => {
    const r = await bbs(B, "GET", "/api/bbs/messages?to=ACSFED");
    return (r.data?.messages ?? []).find((m) => m.bid === enq.data?.bid);
  });
  ok("B: the batch arrived from the marked partner and was taken", !!landed, JSON.stringify(landed));
} else {
  const enq = await call(A, "POST", "/federation/bbs/enqueue", {});
  ok("A: federation over FBB is off by default (enqueue refused)", enq.status === 409, JSON.stringify(enq));
  const offered = await bbs(A, "GET", "/api/bbs/forward/pool?partner=OE1BBB-1");
  ok(
    "A: nothing addressed to ACSFED is offered",
    !(offered.data?.messages ?? []).some((m) => m.to === "ACSFED"),
    JSON.stringify(offered.data),
  );
}

// ---- federation over an AX.25 circuit: A's ingest pulls B's signed feed from B's ingest ----
// A adds B the usual way, which pins B's key after its sysop compares the fingerprint, and trusts it. A learns B's
// ax25 endpoint from B's presence beacon, posted here as A's ingest would after hearing it. A never pulls over
// http in this loop, so a cache of B's on A's map came over the circuit.
const preview = await call(A, "POST", "/federation/peers", { url: B });
ok("A: looked up B's descriptor", !!preview.data?.preview?.fingerprint, JSON.stringify(preview.data));
const added = await call(A, "POST", "/federation/peers", { url: B, fingerprint: preview.data?.preview?.fingerprint });
ok("A: added B as a peer", added.status === 201, JSON.stringify(added.data));
const trusted = await call(A, "POST", "/federation/peers/trust", {
  url: B,
  trust: "trusted",
  fingerprint: preview.data?.preview?.fingerprint,
});
ok("A: trusts B", trusted.data?.ok === true, JSON.stringify(trusted.data));
const beacon = new Uint8Array(await (await fetch(`${B}/federation/beacon`)).arrayBuffer());
const heard = await fetch(`${A}/federation/beacon`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream", "x-ingest-secret": SECRET },
  body: beacon,
});
ok("A: took B's presence beacon", (await heard.json()).applied === 1);
const packetPeers = await call(A, "GET", "/federation/packet/peers");
ok(
  "A: lists B for packet pull at its ax25 endpoint",
  packetPeers.data?.peers?.[0]?.endpoints?.[0]?.address === "OE1BBB-9",
  JSON.stringify(packetPeers.data),
);

const CACHE_TITLE = `Packet circuit ${Date.now()}`;
const ownerB = await operatorSession(B, "OE1BBB");
ok("B: its sysop OE1BBB signs in and is verified", !!ownerB);
const made = await call(
  B,
  "POST",
  "/api/caches",
  { title: CACHE_TITLE, type: "traditional", lat: 48.2082, lon: 16.3738, difficulty: 2, terrain: 2 },
  { cookie: ownerB, "x-ingest-secret": "", "x-operator-secret": "" },
);
ok("B: created a cache", made.status === 201, JSON.stringify(made.data));
const mirrored = await until("B's cache appears on A", 180000, async () => {
  const r = await call(A, "GET", "/api/caches?bbox=16,48,16.6,48.5");
  return (r.data?.caches ?? []).find((c) => c.title === CACHE_TITLE);
});
ok("A: B's cache arrived over the AX.25 circuit", !!mirrored);
// the puller reports the session's outcome after it hands the pages over, so the cache can land first
let pb = null;
const recorded = await until("A records the packet session", 30000, async () => {
  pb = (await call(A, "GET", "/federation/packet/peers")).data?.peers?.[0] ?? null;
  return pb?.lastOk || pb?.lastError ? pb : null;
});
ok("A: the packet session is recorded", !!recorded?.lastOk && !recorded?.lastError, JSON.stringify(pb));
const peerList = await call(A, "GET", "/federation/peers");
const bRow = (peerList.data?.peers ?? []).find((p) => p.url === B);
ok(
  "A: Instance admin shows the packet pull, and no http pull ran",
  bRow?.packet?.transport === "ax25" && !bRow?.last_sync,
  JSON.stringify(bRow),
);

console.log(failures ? `\nINTEROP LOCAL LOOP FAILED (${failures})` : "\nINTEROP LOCAL LOOP PASSED");
process.exit(failures ? 1 : 0);
