// SPDX-License-Identifier: AGPL-3.0-or-later
// Mint a one-time sign-in link with the operator secret — the sign-in path of an off-grid instance, where
// passkeys (no https origin) and email (no provider) are unavailable. The link is single-use, expires in
// 15 minutes, opens a confirm page, and signs in (or creates, unverified) the account holding the call.
// Where passkeys or email work, the gateway issues links only for ADMIN_CALLSIGNS calls, unless it runs
// with OPERATOR_LINKS_FOR_ANY_CALL=1 (an off-grid station minting links for its hotspot visitors).
//
//   OPERATOR_SECRET=… node tools/admin/signin-link.mjs OE8APR
//   OPERATOR_SECRET=… node tools/admin/signin-link.mjs --link-origin https://192.168.43.1:8443 --qr OE8VIS
//   docker compose exec gateway node tools/admin/signin-link.mjs OE8APR     (from deploy/)
//
// The link is a bearer credential: hand it to the person it is for (on their screen, by QR, in person),
// never over a channel others read. BASE is where this script reaches the gateway: it defaults to the
// gateway on this host (http://127.0.0.1:$PORT, PORT defaulting to 8787).
//
//   --link-origin <origin>  the origin the link names: APP_URL, or the station's https hotspot origin
//                    (https://<its private IPv4 address>:<HTTPS_PORT>), the one a visitor's phone opens.
//                    The gateway refuses any other origin. Default: APP_URL.
//   --qr             also print the link as a QR code for a phone to scan.
//
// Exits non-zero on failure.

const BASE = (process.env.BASE ?? `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, "");
const SECRET = process.env.OPERATOR_SECRET;

const USAGE =
  "usage: BASE=<gateway url> OPERATOR_SECRET=<secret> node tools/admin/signin-link.mjs [--link-origin <origin>] [--qr] <CALLSIGN>";

let callsign = "";
let linkBase;
let qr = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--qr") qr = true;
  else if (a === "--link-origin") linkBase = args[++i];
  else if (a.startsWith("--link-origin=")) linkBase = a.slice("--link-origin=".length);
  else if (a.startsWith("-")) {
    console.error(`unknown option ${a}\n${USAGE}`);
    process.exit(2);
  } else callsign = a.trim().toUpperCase();
}

if (!callsign || !SECRET || linkBase === "") {
  console.error(USAGE);
  process.exit(2);
}

const res = await fetch(`${BASE}/auth/operator-link`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-operator-secret": SECRET },
  body: JSON.stringify(linkBase === undefined ? { callsign } : { callsign, base: linkBase }),
}).catch((e) => {
  console.error(`cannot reach ${BASE}: ${e.message}`);
  process.exit(1);
});
const data = await res.json().catch(() => null);
if (res.ok && typeof data?.link === "string") {
  const who = data.account === "new" ? `a new account for ${data.callsign}` : `the account holding ${data.callsign}`;
  console.log(`Sign-in link for ${who} — single use, expires in ${Math.round(data.expiresIn / 60)} minutes:`);
  console.log(data.link);
  if (qr) console.log(await qrText(data.link));
} else if (res.status === 401) {
  console.error("refused: OPERATOR_SECRET is unset on the gateway or does not match");
  process.exit(1);
} else {
  console.error(`refused (${res.status}): ${data?.error ?? "unexpected response"}`);
  process.exit(1);
}

/** The link as terminal text, from the gateway's own encoder (a TypeScript module Node loads directly). */
async function qrText(link) {
  try {
    const mod = await import(new URL("../../workers/gateway/src/qr.ts", import.meta.url).href);
    return `\n${mod.qrText(link)}\n`;
  } catch (e) {
    return `(no QR: this Node cannot load the encoder — ${e.message}; Node 22.18 or later loads it)`;
  }
}
