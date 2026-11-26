// SPDX-License-Identifier: AGPL-3.0-or-later
// An ingest box enrolled with its own Ed25519 key, for the plain-Node scripts that drive a running gateway (the
// smoke suite, the demo seed). It signs the way the ingest box does (apps/ingest/src/gatewayauth.ts, over
// boxRequestMessage and boxEnrollMessage in packages/shared canon.ts); the smoke's on-air callsign proofs
// exercise it end to end, so a drift from the gateway's check fails the smoke. A callsign proof heard on the
// air counts only from such a box, and only such a box is paired and polled: the shared INGEST_SECRET never
// verifies a call or acts for a box.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const SIG_DOMAIN = { box: "acs-box/1\n", boxEnroll: "acs-box-enroll/1\n" };
const b64url = (b) => Buffer.from(b).toString("base64url");
/** Canonical JSON with sorted keys, as packages/shared stableStringify writes a flat message. */
const canon = (o) =>
  `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`)
    .join(",")}}`;

/** A fresh key for box `box`. */
export function newBox(box) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { box, key: privateKey, publicKey: createPublicKey(privateKey).export({ format: "jwk" }).x };
}

/** The body of POST /ingest/enroll for box `k` with the sysop's one-time `code`. */
export function enrollBody(k, code) {
  const normalised = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const at = Math.floor(Date.now() / 1000);
  const message = canon({ v: 1, kind: "box-enroll", box: k.box, key: k.publicKey, code: normalised, at });
  const sig = b64url(sign(null, Buffer.from(SIG_DOMAIN.boxEnroll + message), k.key));
  return { code: normalised, box: k.box, key: k.publicKey, at, sig };
}

/** The headers that sign one request of box `k` to `url`, with `body` as sent. */
export function signedHeaders(k, method, url, body) {
  const u = new URL(url);
  const at = Math.floor(Date.now() / 1000);
  const nonce = b64url(randomBytes(16));
  const digest = createHash("sha256")
    .update(body ?? "")
    .digest("hex");
  const message = canon({
    v: 1,
    kind: "box-request",
    box: k.box,
    method: method.toUpperCase(),
    path: u.pathname + u.search,
    at,
    nonce,
    digest,
  });
  const sig = sign(null, Buffer.from(SIG_DOMAIN.box + message), k.key);
  return { "x-box-id": k.box, "x-box-at": String(at), "x-box-nonce": nonce, "x-box-sig": b64url(sig) };
}

const post = async (base, path, body, headers) => {
  const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};
const opHeaders = (operatorSecret) => ({ "content-type": "application/json", "x-operator-secret": operatorSecret });

/**
 * Enroll box `box` on the gateway at `base` with a code the operator secret creates. Returns `{ key }`, or
 * `{ error }` naming the step the gateway refused and what it answered.
 */
export async function enrollBox(base, operatorSecret, box) {
  const code = await post(base, "/api/admin/boxes/codes", { label: box }, opHeaders(operatorSecret));
  if (code.status !== 201) return { error: `enrollment code: ${code.status} ${code.text}` };
  const k = newBox(box);
  const e = await post(base, "/ingest/enroll", enrollBody(k, JSON.parse(code.text).code), {
    "content-type": "application/json",
  });
  if (e.status !== 201) return { error: `enrollment: ${e.status} ${e.text}` };
  return { key: k };
}

/** Enroll box `box` ({@link enrollBox}) and trust its hearings at `sites`. */
export async function enrollTrustedBox(base, operatorSecret, box, sites) {
  const r = await enrollBox(base, operatorSecret, box);
  if (r.error) return r;
  const t = await post(base, `/api/admin/boxes/${box}/trust`, { trusted: true, sites }, opHeaders(operatorSecret));
  if (t.status !== 200) return { error: `trust: ${t.status} ${t.text}` };
  return r;
}

/** One JSON request signed by box `k`; `{ status, data }`. */
export async function boxFetch(base, k, method, path, body) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...signedHeaders(k, method, base + path, text) },
    body: text,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, data };
}

/**
 * Sign `call` up on `base` by email and return its session cookie, or "" when the gateway opened none. The
 * gateway hands back the magic link's token itself only in development (`ALLOW_DEV_TOKENS`).
 */
export async function signIn(base, call) {
  const st = await fetch(base + "/auth/email/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${call.toLowerCase()}+${Date.now()}@example.test`, callsign: call }),
  });
  const token = (await st.json().catch(() => ({}))).devToken;
  if (!token) return "";
  const vr = await fetch(base + "/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return (/(acs=[^;]+)/.exec(vr.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
}

/**
 * Control-verify `call` the way an operator does on the air: its session starts a challenge, and its
 * `VERIFY <code>` message arrives as heard on the TNC of `site`, delivered by box `k`, which the sysop trusts
 * for that site. Returns true once the gateway lists the call as verified.
 */
export async function verifyOnAir(base, k, cookie, call, site) {
  const start = await fetch(base + "/verify/aprs/start", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ callsign: call }),
  });
  if (start.status !== 200) return false;
  const ch = await start.json();
  await boxFetch(base, k, "POST", "/ingest", {
    packets: [
      {
        src: `${call}-7`,
        dst: "APRS",
        path: ["WIDE1-1", "qAR", site],
        payload: `:${String(ch.to).padEnd(9)}:${ch.text}`,
        kind: "message",
        heardVia: "rf",
        igateCall: site,
        port: "kiss-tnc",
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  });
  const st = await fetch(`${base}/verify/aprs/status?callsign=${call}`);
  return (await st.json().catch(() => ({}))).verified === true;
}
