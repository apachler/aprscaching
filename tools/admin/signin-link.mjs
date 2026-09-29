// SPDX-License-Identifier: AGPL-3.0-or-later
// Mint a one-time sign-in link with the operator secret — the sign-in path of an off-grid instance, where
// passkeys (no https origin) and email (no provider) are unavailable. The link is single-use, expires in
// 15 minutes, opens a confirm page, and signs in (or creates, unverified) the account holding the call.
// Where passkeys or email work, the gateway issues links only for ADMIN_CALLSIGNS calls.
//
//   OPERATOR_SECRET=… node tools/admin/signin-link.mjs OE8APR
//   docker compose exec gateway node tools/admin/signin-link.mjs OE8APR     (from deploy/)
//
// The link is a bearer credential: hand it to the person it is for (on their screen, by QR, in person),
// never over a channel others read. BASE defaults to the gateway on this host (http://127.0.0.1:$PORT,
// PORT defaulting to 8787). Exits non-zero on failure.

const BASE = (process.env.BASE ?? `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, "");
const SECRET = process.env.OPERATOR_SECRET;
const callsign = (process.argv[2] ?? "").trim().toUpperCase();

if (!callsign || !SECRET) {
  console.error("usage: BASE=<gateway url> OPERATOR_SECRET=<secret> node tools/admin/signin-link.mjs <CALLSIGN>");
  process.exit(2);
}

const res = await fetch(`${BASE}/auth/operator-link`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-operator-secret": SECRET },
  body: JSON.stringify({ callsign }),
}).catch((e) => {
  console.error(`cannot reach ${BASE}: ${e.message}`);
  process.exit(1);
});
const data = await res.json().catch(() => null);
if (res.ok && typeof data?.link === "string") {
  const who = data.account === "new" ? `a new account for ${data.callsign}` : `the account holding ${data.callsign}`;
  console.log(`Sign-in link for ${who} — single use, expires in ${Math.round(data.expiresIn / 60)} minutes:`);
  console.log(data.link);
} else if (res.status === 401) {
  console.error("refused: OPERATOR_SECRET is unset on the gateway or does not match");
  process.exit(1);
} else {
  console.error(`refused (${res.status}): ${data?.error ?? "unexpected response"}`);
  process.exit(1);
}
