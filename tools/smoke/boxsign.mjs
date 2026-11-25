// SPDX-License-Identifier: AGPL-3.0-or-later
// An ingest box enrolled with its own Ed25519 key, for the plain-Node scripts that drive a running gateway (the
// smoke suite, the demo seed). It signs the way the ingest box does (apps/ingest/src/gatewayauth.ts, over
// boxRequestMessage and boxEnrollMessage in packages/shared canon.ts); the smoke's on-air callsign proofs
// exercise it end to end, so a drift from the gateway's check fails the smoke. A callsign proof heard on the
// air counts only from such a box: the shared INGEST_SECRET never verifies a call.
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

/**
 * Enroll box `box` on the gateway at `base` with the operator secret, and trust its hearings at `sites`.
 * Returns `{ key }`, or `{ error }` naming the step the gateway refused and what it answered.
 */
export async function enrollTrustedBox(base, operatorSecret, box, sites) {
  const op = { "content-type": "application/json", "x-operator-secret": operatorSecret };
  const post = async (path, body, headers) => {
    const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const code = await post("/api/admin/boxes/codes", { label: box }, op);
  if (code.status !== 201) return { error: `enrollment code: ${code.status} ${code.text}` };
  const k = newBox(box);
  const e = await post("/ingest/enroll", enrollBody(k, JSON.parse(code.text).code), {
    "content-type": "application/json",
  });
  if (e.status !== 201) return { error: `enrollment: ${e.status} ${e.text}` };
  const t = await post(`/api/admin/boxes/${box}/trust`, { trusted: true, sites }, op);
  if (t.status !== 200) return { error: `trust: ${t.status} ${t.text}` };
  return { key: k };
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
