// SPDX-License-Identifier: AGPL-3.0-or-later
// APRS-IS interop against the REAL core server (aprsc): the acs ingest dials aprsc's igate port
// with login + server-side filter; this driver logs in as a second verified client, beacons a
// position inside the ingest's filter radius, and asserts the packet traveled
// driver -> aprsc -> acs ingest -> gateway (station visible in the API).
import net from "node:net";

const ACS = process.env.ACS ?? "http://127.0.0.1:8787";
const SECRET = process.env.INGEST_SECRET ?? "interop-ci-secret-0001";
const IS = { host: process.env.APRSC_HOST ?? "127.0.0.1", port: Number(process.env.APRSC_PORT ?? 14580) };
const CALL = "OE9TST-9";
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK " : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Standard APRS-IS passcode (hash of the base call) — aprsc verifies it on login. */
function passcode(call) {
  const c = call.toUpperCase().split("-")[0];
  let hash = 0x73e2;
  for (let i = 0; i < c.length; i += 2) {
    hash ^= c.charCodeAt(i) << 8;
    if (i + 1 < c.length) hash ^= c.charCodeAt(i + 1);
  }
  return hash & 0x7fff;
}

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

const gwUp = await until(30000, async () => (await api("/health")).status === 200);
ok("acs gateway is reachable", !!gwUp, `no response from ${ACS}/health`);

// ---- login to the real aprsc as a verified client and beacon inside the acs filter radius ----
const session = await new Promise((resolve) => {
  const s = net.connect(IS.port, IS.host);
  let out = "";
  let sentLogin = false;
  let sentBeacon = false;
  s.on("data", (b) => {
    out += b.toString("latin1");
    if (!sentLogin && /^# aprsc/m.test(out)) {
      sentLogin = true;
      s.write(`user ${CALL} pass ${passcode(CALL)} vers aprscaching-interop 1.0\r\n`);
    }
    if (sentLogin && !sentBeacon && /logresp/.test(out)) {
      sentBeacon = true;
      // 47°04.30'N 15°26.00'E — inside the ingest's default r/47.07/15.42/300 filter
      const beacon = () => s.write(`${CALL}>APRS,TCPIP*:!4704.30N/01526.00E>aprsc interop beacon\r\n`);
      beacon();
      const t = setInterval(beacon, 5000); // re-beacon in case the ingest was mid-reconnect
      setTimeout(() => clearInterval(t), 55000);
    }
  });
  s.on("error", () => resolve(out));
  setTimeout(() => {
    s.destroy();
    resolve(out);
  }, 60000);
});

ok("aprsc greets with its server banner", /^# aprsc/m.test(session), JSON.stringify(session.slice(0, 120)));
ok(
  `aprsc verifies the ${CALL} login (passcode accepted)`,
  new RegExp(`logresp ${CALL} verified`).test(session),
  JSON.stringify((session.match(/logresp[^\n]*/) ?? ["no logresp line"])[0]),
);

// ---- the beacon must arrive through the acs ingest into the gateway ----
const station = await until(90000, async () => {
  const list = await api(`/api/stations`);
  return (list.data?.stations ?? []).find((s) => s.callsign === CALL) ?? null;
});
ok("beacon delivered aprsc -> acs ingest -> gateway (station visible)", !!station, `no ${CALL} in /api/stations`);

console.log(failures ? `\nAPRS-IS INTEROP FAILED (${failures})` : "\nAPRS-IS INTEROP PASSED");
process.exit(failures ? 1 : 0);
