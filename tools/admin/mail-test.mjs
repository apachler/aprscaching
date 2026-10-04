// SPDX-License-Identifier: AGPL-3.0-or-later
// Send one test mail over the gateway's own mail transport (SMTP, or the Resend API) and print the outcome:
// the transport on success, the server's reason on a refusal. It posts to /api/admin/mail-test with the
// operator secret, so the mail goes out exactly the way sign-in links and the watch digest do.
//
//   OPERATOR_SECRET=… node tools/admin/mail-test.mjs you@example.net
//   docker compose exec gateway node tools/admin/mail-test.mjs you@example.net     (from deploy/)
//
// BASE is where this script reaches the gateway: it defaults to the gateway on this host
// (http://127.0.0.1:$PORT, PORT defaulting to 8787). Exits non-zero on failure.

const BASE = (process.env.BASE ?? `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, "");
const SECRET = process.env.OPERATOR_SECRET;
const to = process.argv[2]?.trim() ?? "";

if (!to || to.startsWith("-") || !SECRET) {
  console.error("usage: BASE=<gateway url> OPERATOR_SECRET=<secret> node tools/admin/mail-test.mjs <address>");
  process.exit(2);
}

const res = await fetch(`${BASE}/api/admin/mail-test`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-operator-secret": SECRET },
  body: JSON.stringify({ to }),
}).catch((e) => {
  console.error(`cannot reach ${BASE}: ${e.message}`);
  process.exit(1);
});
const data = await res.json().catch(() => null);
if (res.ok && data?.ok) {
  console.log(`sent to ${to} over ${data.transport}`);
} else if (res.status === 401) {
  console.error("refused: OPERATOR_SECRET is unset on the gateway or does not match");
  process.exit(1);
} else {
  const over = data?.transport ? ` over ${data.transport}` : "";
  console.error(`not sent${over}: ${data?.error ?? `unexpected response (${res.status})`}`);
  process.exit(1);
}
