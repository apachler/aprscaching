// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * verify_lotw.ts — callsign control-verification with an ARRL Logbook of The World callsign certificate
 * (`lotw`).
 *
 * ARRL issues a LoTW callsign certificate only after checking the holder's licence; TQSL keeps its RSA
 * private key and exports both as a password-protected PKCS#12 (.p12) file. The web app opens that file
 * in the browser, signs this gateway's challenge with the private key, and sends only the certificate
 * chain and the signature — the key and the password never leave the browser. The gateway then checks:
 *
 *  - the signature over the challenge message, under the callsign certificate's RSA key;
 *  - the chain from that certificate, through the CA certificates sent with it, to a trust anchor the
 *    operator configured (`LOTW_CA_PEM`) — every signature, and every CA flag and key usage;
 *  - the dates: the callsign certificate is valid now, and each CA was valid when it issued the
 *    certificate below it (a trust anchor is trusted as configured, whatever its dates);
 *  - the callsign: the certificate's subject attribute AROcallsign (OID 1.3.6.1.4.1.12348.1.1, as tqsllib
 *    defines it) is exactly the base call being verified.
 *
 * No ARRL certificate ships with the gateway: until the operator names the LoTW CA certificates to trust,
 * the method is unavailable. Revocation (LoTW's certificate status service) is not consulted.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { markVerified } from "./callsign.js";
import {
  parseCertificate,
  pemBlocks,
  verifiedBy,
  rsaVerify,
  subjectAttr,
  base64Bytes,
  RSA_ENCRYPTION,
  type Certificate,
} from "./x509.js";
import {
  holderOf,
  issueChallenge,
  openChallenge,
  completionLimited,
  failAttempt,
  spendChallenge,
  randomToken,
  noChallenge,
  startsLimited,
} from "./verify_challenge.js";

/** tqsllib's AROcallsign subject attribute: the callsign a LoTW certificate is issued for. */
export const AROCALLSIGN_OID = "1.3.6.1.4.1.12348.1.1";
const COMMON_NAME_OID = "2.5.4.3";
/** A challenge is signed right after it is issued: good for 15 minutes. */
export const LOTW_CHALLENGE_TTL_SEC = 15 * 60;
const MAX_CERTS = 8;
const MAX_CERT_B64 = 16_384;
const MAX_SIG_B64 = 2_048;
const MAX_DEPTH = 6;

/** The exact text the browser signs: domain-separated, and bound to the call and the challenge. */
export const lotwMessage = (cs: string, challenge: string) => `aprscaching-lotw-verify:v1:${cs}:${challenge}`;

/** The callsign a LoTW certificate names, uppercased, or null. */
export function lotwCallsign(c: Certificate): string | null {
  return subjectAttr(c, AROCALLSIGN_OID)?.trim().toUpperCase() ?? null;
}

let anchorCache: { src: string; certs: Certificate[] } | null = null;

/** The operator's trusted LoTW CA certificates (`LOTW_CA_PEM`); unparseable blocks are skipped. */
export function lotwAnchors(env: Env): Certificate[] {
  const src = env.LOTW_CA_PEM ?? "";
  if (anchorCache?.src === src) return anchorCache.certs;
  const certs: Certificate[] = [];
  for (const der of pemBlocks(src)) {
    try {
      certs.push(parseCertificate(der));
    } catch {
      /* skipped: not a certificate */
    }
  }
  anchorCache = { src, certs };
  return certs;
}

export type ChainResult = { ok: true; leaf: Certificate; anchor: Certificate } | { ok: false; error: string };

const within = (c: Certificate, t: number) => c.notBefore <= t && t <= c.notAfter;

/**
 * Check a callsign certificate and the CA certificates sent with it against the trust anchors. The
 * callsign certificate is the one end-entity (non-CA) certificate that names a callsign.
 */
export async function verifyLotwChain(ders: Uint8Array[], anchors: Certificate[], now: number): Promise<ChainResult> {
  let certs: Certificate[];
  try {
    certs = ders.map(parseCertificate);
  } catch {
    return { ok: false, error: "a certificate could not be read" };
  }
  const leaves = certs.filter((c) => !c.ca && lotwCallsign(c));
  if (leaves.length !== 1) return { ok: false, error: "exactly one LoTW callsign certificate is required" };
  const leaf = leaves[0]!;
  if (leaf.keyAlg !== RSA_ENCRYPTION || !leaf.digitalSignature)
    return { ok: false, error: "the callsign certificate does not carry an RSA signing key" };
  if (!within(leaf, now)) return { ok: false, error: "the callsign certificate is expired or not yet valid" };
  if (anchors.length === 0) return { ok: false, error: "no LoTW CA certificate is trusted on this instance" };

  const used = new Set<Certificate>([leaf]);
  let cur = leaf;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    for (const a of anchors) if (await verifiedBy(cur, a)) return { ok: true, leaf, anchor: a };
    let next: Certificate | null = null;
    for (const c of certs) {
      if (used.has(c) || !c.ca || !c.keyCertSign || !within(c, cur.notBefore)) continue;
      if (await verifiedBy(cur, c)) {
        next = c;
        break;
      }
    }
    if (!next) break;
    used.add(next);
    cur = next;
  }
  return { ok: false, error: "the certificate does not chain to a LoTW CA this instance trusts" };
}

/** GET /verify/methods — which verification methods this instance offers. */
export function verifyMethods(env: Env): Response {
  return json({ methods: { rf_heard: true, ampr_dns: true, lotw: lotwAnchors(env).length > 0 } });
}

/** POST /verify/lotw/start {callsign} — issue a challenge and the exact message to sign. */
export async function startLotwChallenge(req: Request, env: Env): Promise<Response> {
  const c = await holderOf(req, env);
  if (c instanceof Response) return c;
  if (lotwAnchors(env).length === 0)
    return json({ error: "LoTW certificate verification is not configured on this instance" }, { status: 503 });
  const challenge = randomToken(24);
  const issued = await issueChallenge(env, c, "lotw", challenge);
  if (!issued) return startsLimited();
  return json({
    challenge,
    message: lotwMessage(c.cs, challenge),
    algorithm: "RSASSA-PKCS1-v1_5/SHA-256",
    expiresAt: issued.createdAt + LOTW_CHALLENGE_TTL_SEC,
  });
}

/**
 * POST /verify/lotw/complete {callsign, certificates: base64 DER[], signature: base64} — verify the call
 * when the signature, the chain, the dates and the callsign all check out.
 */
export async function completeLotwChallenge(req: Request, env: Env): Promise<Response> {
  const c = await holderOf(req, env);
  if (c instanceof Response) return c;
  const certsIn = c.body.certificates;
  const sigIn = c.body.signature;
  if (
    !Array.isArray(certsIn) ||
    certsIn.length === 0 ||
    certsIn.length > MAX_CERTS ||
    certsIn.some((x) => typeof x !== "string" || x.length > MAX_CERT_B64) ||
    typeof sigIn !== "string" ||
    sigIn.length > MAX_SIG_B64
  )
    return json({ error: "certificates and a signature are required" }, { status: 400 });
  const ders = certsIn.map(base64Bytes);
  const signature = base64Bytes(sigIn);
  if (ders.some((d) => !d) || !signature)
    return json({ error: "certificates and signature must be base64" }, { status: 400 });

  if (await completionLimited(env, c, "lotw")) return startsLimited();
  const challenge = await openChallenge(env, c, "lotw", LOTW_CHALLENGE_TTL_SEC);
  if (!challenge) return noChallenge();
  const refuse = async (error: string) => {
    await failAttempt(env, c, "lotw", challenge);
    return json({ error }, { status: 422 });
  };

  const chain = await verifyLotwChain(ders as Uint8Array[], lotwAnchors(env), Date.now());
  if (!chain.ok) return refuse(chain.error);
  const certCall = lotwCallsign(chain.leaf);
  if (certCall !== c.cs) return refuse(`the certificate is issued for ${certCall}, not ${c.cs}`);
  const message = new TextEncoder().encode(lotwMessage(c.cs, challenge));
  if (!(await rsaVerify(chain.leaf.spki, "SHA-256", signature, message)))
    return refuse("the signature does not match this challenge and certificate");

  if (!(await spendChallenge(env, c, "lotw", challenge))) return noChallenge();
  const by = subjectAttr(chain.anchor, COMMON_NAME_OID) ?? "LoTW";
  const until = new Date(chain.leaf.notAfter).toISOString().slice(0, 10);
  await markVerified(env, c.cs, "lotw", {
    by,
    note: `LoTW certificate serial ${chain.leaf.serialHex}, valid until ${until}`,
  });
  return json({ verified: true, callsign: c.cs, method: "lotw" });
}
