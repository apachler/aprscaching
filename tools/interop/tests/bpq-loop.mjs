// SPDX-License-Identifier: AGPL-3.0-or-later
// Interop assertions against a real LinBPQ peer (compose service `linbpq`): NODES learned in both
// directions, and an FBB forwarding exchange landing a message in the BPQ BBS. Asserts through BOTH
// ends — our gateway HTTP API and BPQ's telnet console.
//
//   ACS=http://127.0.0.1:8787 BPQ_HOST=127.0.0.1 BPQ_PORT=8010 node tools/interop/tests/bpq-loop.mjs
import net from "node:net";

const ACS = process.env.ACS ?? "http://127.0.0.1:8787";
const SECRET = process.env.INGEST_SECRET ?? "interop-ci-secret-0001";
const BPQ = { host: process.env.BPQ_HOST ?? "127.0.0.1", port: Number(process.env.BPQ_PORT ?? 8010) };
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK " : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  try {
    const res = await fetch(ACS + path, {
      method,
      headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch (e) {
    return { status: 0, data: null, error: String(e?.cause ?? e) };
  }
}

/** Drive the BPQ telnet console: login, send lines, capture output until quiet (or `waitFor`
 *  matches — resolve early, and never type past a still-pending command, which would abort it). */
function bpqConsole(lines, { settleMs = 1500, totalMs = 20000, waitFor = null } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(BPQ.port, BPQ.host);
    let out = "";
    let idx = 0;
    let timer = null;
    const send = (s) => sock.write(s + "\r");
    const done = () => {
      sock.destroy();
      resolve(out);
    };
    sock.on("data", (b) => {
      out += b.toString("latin1");
      if (waitFor && waitFor.test(out)) return void setTimeout(done, 250); // let the burst flush
      if (/user:/i.test(out) && idx === 0) {
        idx = 1;
        send("interop");
      } else if (/password:/i.test(out) && idx === 1) {
        idx = 2;
        send("interop");
      } else if (idx >= 2 && idx - 2 < lines.length) {
        // send the next command once the console settles after the previous burst
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => send(lines[idx++ - 2]), settleMs);
      }
    });
    sock.on("error", done);
    setTimeout(done, totalMs);
  });
}

async function until(deadlineMs, check) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > deadlineMs) return null;
    await sleep(2000);
  }
}

// ---- 0. both ends must be up before any assertion — a dead container gets a clear line, not a stack ----
const gwUp = await until(30000, async () => (await api("GET", "/health")).status === 200);
ok("acs gateway is reachable", !!gwUp, `no response from ${ACS}/health — is the acs container running?`);
const bpqUp = await until(
  30000,
  () =>
    new Promise((resolve) => {
      const sock = net.connect(BPQ.port, BPQ.host);
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    }),
);
ok(
  "BPQ telnet console is reachable",
  !!bpqUp,
  `nothing listening on ${BPQ.host}:${BPQ.port} — did the linbpq container exit? (docker compose logs linbpq)`,
);
if (!gwUp || !bpqUp) {
  console.log(`\nBPQ INTEROP FAILED (${failures}) — environment not up, assertions skipped`);
  process.exit(1);
}

// ---- 1. NODES interop: we learn BPQ, BPQ learns us ----
const learned = await until(120000, async () => {
  const r = await api("GET", "/api/node/nodes");
  return (r.data?.nodes ?? []).some((n) => /BPQ/.test(n.alias ?? "") || /GB7BPQ/.test(n.dest ?? ""));
});
ok("acs learned BPQ from its NODES broadcasts", !!learned);

const bpqNodes = await bpqConsole(["NODES"]);
ok("BPQ NODES table lists our alias ACS", /ACS/.test(bpqNodes), bpqNodes.slice(-300));

// ---- 1b. connected mode: BPQ dials our node over AX.25 (SABM/UA + I-frames on the AXUDP wire) ----
// One command per console — typing anything while the connect is pending aborts it. BPQ opens
// with a v2.2 XID probe and NEVER falls back on silence (it retries XID N2 times, then abandons
// the connect) — our session server answers the probe with DM, which makes BPQ mark us as a
// v2.0 station and dial again with a plain SABM. Two dial syntaxes: `C 1 <call>` is a direct
// port-1 downlink; `C ACS` routes via the alias BPQ learned from our NODES broadcasts.
const CONNECTED = /APRScaching NET\/ROM node/i;
const SETTLED = /APRScaching NET\/ROM node|Failure with|Busy from|Invalid|Error/i;
let session = await bpqConsole(["C 1 OE1ACS-7"], { settleMs: 3000, totalMs: 75000, waitFor: SETTLED });
if (!CONNECTED.test(session)) {
  const viaAlias = await bpqConsole(["C ACS"], { settleMs: 3000, totalMs: 75000, waitFor: SETTLED });
  session += "\n--- retry via alias: C ACS ---\n" + viaAlias;
}
ok(
  "BPQ opens an AX.25 session to our node (L2 connect + CLI greeting)",
  CONNECTED.test(session),
  JSON.stringify(session),
);

// ---- 2. FBB forward acs -> BPQ BBS ----
await api("POST", "/api/bbs/partners", { call: "GB7BPQ-1", ha: "GB7BPQ.GBR.EU", proto: "rf-fbb", enabled: true });
await api("POST", "/api/bbs/forward", { partner: "GB7BPQ-1", route: "GBR", transport: "rf-fbb" });
await api("POST", "/api/bbs/messages", {
  fromCall: "OE1ACS",
  toCall: "SYSOP @ GB7BPQ.GBR.EU",
  subject: "interop bpq",
  body: "delivered by the aprscaching FBB forwarder",
});
// probe whether this LinBPQ build has its mail application running — its integrated BBS is
// configured out-of-band (web admin) and varies by version. Without it the forward session can
// never complete, so the mail assertions become an explicit skip; end-to-end FBB mail delivery
// is asserted against the F6FBB peer, which runs a real mailbox.
const bbsProbe = await bpqConsole(["BBS"], { settleMs: 1500, totalMs: 15000 });
const bbsRunning = !/Application BBS is not running/i.test(bbsProbe);
if (!bbsRunning) {
  console.log("SKIP acs forward pool drain + BPQ mail list — this LinBPQ build runs no mail application");
} else {
  const drained = await until(180000, async () => {
    const r = await api("GET", "/api/bbs/forward/pool?partner=GB7BPQ-1");
    return r.status === 200 && (r.data?.messages ?? []).length === 0;
  });
  ok("acs forward pool drained (session with BPQ completed)", !!drained);

  // list mail on the BPQ BBS and look for our subject
  const bpqMail = await bpqConsole(["BBS", "LL 5", "B"], { totalMs: 30000 });
  ok("message visible in the BPQ BBS message list", /interop bpq/i.test(bpqMail), bpqMail.slice(-400));
}

console.log(failures ? `\nBPQ INTEROP FAILED (${failures})` : "\nBPQ INTEROP PASSED");
process.exit(failures ? 1 : 0);
