// SPDX-License-Identifier: AGPL-3.0-or-later
// Interop assertions against the source-built peers: TheNetNode (TNN, TheNet-lineage NET/ROM)
// and JNOS (NOS-lineage NET/ROM + FBB forwarding), both over AXUDP. Which peers actually run is
// decided by the workflow (a mirror outage skips that peer's build): TNN_UP / JNOS_UP carry the
// build outcomes, and a peer that is not up gets an explicit SKIP, never a silent pass.
import net from "node:net";

const ACS = process.env.ACS ?? "http://127.0.0.1:8787";
const SECRET = process.env.INGEST_SECRET ?? "interop-ci-secret-0001";
const TNN_UP = (process.env.TNN_UP ?? "success") === "success";
const JNOS_UP = (process.env.JNOS_UP ?? "success") === "success";
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK " : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  try {
    const res = await fetch(ACS + path, { headers: { "x-ingest-secret": SECRET } });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch (e) {
    return { status: 0, data: null, error: String(e?.cause ?? e) };
  }
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
const tcpUp = (host, port) =>
  new Promise((resolve) => {
    const s = net.connect(port, host);
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    setTimeout(() => {
      s.destroy();
      resolve(false);
    }, 5000);
  });

/** Drive a peer's telnet console with a fixed script and print the raw transcript — the peer's
 *  own view of its interfaces is the diagnostic when its NODES never reach us. */
function consoleDump(name, port, lines) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let out = "";
    let i = 0;
    s.on("data", (b) => (out += b.toString("latin1")));
    s.on("error", () => {});
    const timer = setInterval(() => {
      if (i < lines.length) s.write(lines[i++] + "\r\n");
      else {
        clearInterval(timer);
        setTimeout(() => {
          s.destroy();
          console.log(`--- ${name} console transcript ---\n${out.replace(/[^\x20-\x7e\n\r]/g, ".")}\n--- end ---`);
          resolve();
        }, 2500);
      }
    }, 1500);
  });
}

const gwUp = await until(30000, async () => (await api("/health")).status === 200);
ok("acs gateway is reachable", !!gwUp, `no response from ${ACS}/health`);
if (!gwUp) {
  console.log(`\nEXTRA-PEERS INTEROP FAILED (${failures}) — environment not up`);
  process.exit(1);
}

/** Poll the acs NODES table for an alias/dest learned from a peer's broadcasts. TNN sends its
 *  first broadcast only after its neighbour registration settles (observed ~4.5 min after boot),
 *  so the window is generous. */
const learned = (aliasRe, destRe, windowMs = 360000) =>
  until(windowMs, async () => {
    const r = await api("/api/node/nodes");
    return (r.data?.nodes ?? []).some((n) => aliasRe.test(n.alias ?? "") || destRe.test(n.dest ?? ""));
  });

// the two NODES-learn polls run CONCURRENTLY — TNN's first broadcast has been observed as late
// as ~11 minutes after boot, so the windows are long and must overlap to fit the job budget
const tnnLearnedP = TNN_UP ? learned(/TNN/, /OE9TNN/, 720000) : null;
const jnosLearnedP = JNOS_UP ? learned(/NOS/, /OE9NOS/, 720000) : null;

if (TNN_UP) {
  ok("TNN telnet console is reachable", await tcpUp("127.0.0.1", 4711), "nothing on :4711 — tnn container down?");
  const tnnLearned = !!(await tnnLearnedP);
  ok("acs learned TNN from its NODES broadcasts", tnnLearned);
  if (!tnnLearned) await consoleDump("TNN", 4711, ["interop", "AXIPR", "PORT *", "MH", "QUIT"]);
} else {
  skip("TNN NODES interop", "TNN build failed (source mirror) — see the build step");
}

if (JNOS_UP) {
  ok("JNOS telnet console is reachable", await tcpUp("127.0.0.1", 2323), "nothing on :2323 — jnos container down?");
  const jnosLearned = !!(await jnosLearnedP);
  ok("acs learned JNOS from its NODES broadcasts", jnosLearned);
  if (!jnosLearned)
    await consoleDump("JNOS", 2323, ["", "interop", "interop", "ifconfig", "netrom status", "attach", "exit"]);
} else {
  skip("JNOS NODES interop", "JNOS build failed (source mirror) — see the build step");
}

console.log(failures ? `\nEXTRA-PEERS INTEROP FAILED (${failures})` : "\nEXTRA-PEERS INTEROP PASSED");
process.exit(failures ? 1 : 0);
