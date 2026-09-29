// SPDX-License-Identifier: AGPL-3.0-or-later
// Confirm the instance operator's own callsign (a call listed in ADMIN_CALLSIGNS) with the ingest
// secret. This opens the sysop role on a fresh instance, where no attested receiving site may exist yet
// to hear an on-air VERIFY. The gateway refuses any call not in ADMIN_CALLSIGNS.
//
//   BASE=https://api.example.net INGEST_SECRET=… node tools/admin/verify-call.mjs OE8APR
//
// BASE defaults to http://127.0.0.1:8787; INGEST_SECRET is required. Exits non-zero on failure.

const BASE = (process.env.BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const SECRET = process.env.INGEST_SECRET;
const callsign = (process.argv[2] ?? "").trim().toUpperCase();

if (!callsign || !SECRET) {
  console.error("usage: BASE=<gateway url> INGEST_SECRET=<secret> node tools/admin/verify-call.mjs <CALLSIGN>");
  process.exit(2);
}

const res = await fetch(`${BASE}/verify/operator`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
  body: JSON.stringify({ callsign }),
}).catch((e) => {
  console.error(`cannot reach ${BASE}: ${e.message}`);
  process.exit(1);
});
const data = await res.json().catch(() => null);
if (res.ok && data?.verified === true) {
  console.log(`${data.callsign} is verified (method: operator). Sign in as ${data.callsign} to open instance admin.`);
} else if (res.status === 401) {
  console.error("refused: INGEST_SECRET does not match the gateway's");
  process.exit(1);
} else {
  console.error(`refused (${res.status}): ${data?.error ?? "unexpected response"}`);
  process.exit(1);
}
