// SPDX-License-Identifier: AGPL-3.0-or-later
// Confirm the instance operator's own callsign (a call listed in ADMIN_CALLSIGNS) with the operator
// secret. This opens the sysop role on a fresh instance, where no attested receiving site may exist yet
// to hear an on-air VERIFY. The gateway refuses any call not in ADMIN_CALLSIGNS, and refuses every
// request while OPERATOR_SECRET is unset on the gateway.
//
//   BASE=https://api.example.net OPERATOR_SECRET=… node tools/admin/verify-call.mjs OE8APR
//   docker compose exec gateway node tools/admin/verify-call.mjs OE8APR     (from deploy/)
//
// The script first shows the account that holds the call (its id, the call it operates, its passkeys and
// email) and asks before verifying: the verification lands on that account. --yes skips the question; a
// run without a terminal needs it.
//
// BASE defaults to the gateway on this host (http://127.0.0.1:$PORT, PORT defaulting to 8787), so inside
// the gateway container, which carries PORT and OPERATOR_SECRET, no variable is needed. OPERATOR_SECRET is
// required. Exits non-zero on failure.
import { createInterface } from "node:readline/promises";

const BASE = (process.env.BASE ?? `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, "");
const SECRET = process.env.OPERATOR_SECRET;
const USAGE = "usage: BASE=<gateway url> OPERATOR_SECRET=<secret> node tools/admin/verify-call.mjs [--yes] <CALLSIGN>";

let callsign = "";
let yes = false;
for (const a of process.argv.slice(2)) {
  if (a === "--yes" || a === "-y") yes = true;
  else if (a.startsWith("-")) {
    console.error(`unknown option ${a}\n${USAGE}`);
    process.exit(2);
  } else callsign = a.trim().toUpperCase();
}

if (!callsign || !SECRET) {
  console.error(USAGE);
  process.exit(2);
}

async function post(body) {
  const res = await fetch(`${BASE}/verify/operator`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-secret": SECRET },
    body: JSON.stringify(body),
  }).catch((e) => {
    console.error(`cannot reach ${BASE}: ${e.message}`);
    process.exit(1);
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    console.error("refused: OPERATOR_SECRET is unset on the gateway or does not match");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`refused (${res.status}): ${data?.error ?? "unexpected response"}`);
    process.exit(1);
  }
  return data;
}

/** One line per fact about the account holding the call. */
function describe(holder) {
  if (!holder) return ["No account holds this call yet: sign in as it first, then run this again."];
  const created = holder.createdAt ? new Date(holder.createdAt * 1000).toISOString().slice(0, 10) : "?";
  return [
    `Account     ${holder.accountId} (created ${created})`,
    `Operating   ${holder.activeCallsign}`,
    `Passkeys    ${holder.passkeys}`,
    `Email       ${holder.email ? "confirmed address on file" : "none"}`,
  ];
}

const preview = await post({ callsign, preview: true });
console.log(`${preview.callsign} is held by:`);
for (const line of describe(preview.holder)) console.log(`  ${line}`);
if (!preview.holder) process.exit(1);

if (!yes) {
  if (!process.stdin.isTTY) {
    console.error("not verified: confirm on a terminal, or pass --yes");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Verify ${preview.callsign} for this account? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.error("not verified");
    process.exit(1);
  }
}

const data = await post({ callsign });
if (data?.verified === true) {
  console.log(`${data.callsign} is verified (method: operator). Sign in as ${data.callsign} to open instance admin.`);
} else {
  console.error("refused: unexpected response");
  process.exit(1);
}
