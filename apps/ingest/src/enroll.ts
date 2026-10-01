// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Enroll this box with its gateway using a one-time code from Instance admin → Boxes. It generates the box's
 * Ed25519 key, registers the public half with the code, and prints the two settings the box then runs with:
 *
 *   node --import tsx src/enroll.ts --code ABCD-EFGH-JKLM-NPQR [--url https://gw.example/ingest] [--box ID] [--label NAME]
 *
 * stdout carries exactly `BOX_ID=…` and `BOX_KEY=…`, for the deploy helper to write into the box's .env;
 * BOX_KEY is the private key, so stdout belongs in that file, not on a screen. Messages go to stderr.
 * --url defaults to INGEST_URL, --box to BOX_ID, else a new random id.
 */
import { createPrivateKey, randomBytes } from "node:crypto";
import { enrollBody, newBoxKey, type BoxKey } from "./gatewayauth.js";
import { loadDotEnv } from "./config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

loadDotEnv();
const code = arg("code");
const url = (arg("url") ?? process.env.INGEST_URL ?? "").replace(/\/+$/, "");
const box = arg("box") ?? process.env.BOX_ID ?? `box-${randomBytes(5).toString("hex")}`;
const label = arg("label");
if (!code || !url) {
  console.error("usage: enroll.ts --code CODE [--url INGEST_URL] [--box ID] [--label NAME]");
  process.exit(2);
}

const { boxKey, publicKey } = newBoxKey();
const key: BoxKey = {
  box,
  key: createPrivateKey({ key: Buffer.from(boxKey, "base64url"), format: "der", type: "pkcs8" }),
  publicKey,
};
const res = await fetch(`${url}/enroll`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(enrollBody(key, code, label)),
}).catch((e: Error) => {
  console.error(`enroll: the gateway at ${url} does not answer (${e.message})`);
  process.exit(1);
});
const body = (await res.json().catch(() => ({}))) as { error?: string; box?: string; callsign?: string | null };
if (!res.ok) {
  console.error(`enroll: ${body.error ?? `HTTP ${res.status}`}`);
  process.exit(1);
}
console.error(`enroll: box ${body.box} enrolled${body.callsign ? ` for ${body.callsign}` : ""}`);
process.stdout.write(`BOX_ID=${box}\nBOX_KEY=${boxKey}\n`);
