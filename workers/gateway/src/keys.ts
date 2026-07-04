// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * keys.ts — per-callsign device keys. A logger holds an Ed25519 keypair on their device and
 * registers the public key against their callsign. Find logs are then signed by that key, so the
 * authorship of a find is cryptographically attributable to a callsign and verifiable network-wide
 * (not merely asserted by an instance). Whether a key is *authorised* for a callsign is the job of
 * the callsign-control badge (we record its verified state at registration).
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { RegisterKeyRequest, authorshipMessage, ingestMessage, sha256Hex, stableStringify } from "@aprsweb/shared";
import { importVerifyKey, fromB64 } from "./federation.js";
import { isCallsignVerified } from "./callsign.js";
import { sessionCallsign, secretOk } from "./auth.js";

export async function handleRegisterKey(req: Request, env: Env): Promise<Response> {
  const parsed = RegisterKeyRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  // Registering a key BINDS it to a callsign, and account.ts authorises destructive
  // account actions (delete/bundle/move) by "any registered key" — so registration itself must be
  // authenticated. A signed-in session registers for its own base call (any SSID of it); the
  // trusted ingest daemon (shared secret) registers for the callsign it heard. Never an anonymous body.
  const session = await sessionCallsign(req, env);
  const base = (c: string) => c.toUpperCase().split("-")[0] ?? "";
  let callsign: string;
  if (session) {
    callsign = (parsed.data.callsign ?? session).toUpperCase();
    if (base(callsign) !== base(session)) return json({ error: "callsign is not yours" }, { status: 403 });
  } else if (secretOk(req.headers.get("x-ingest-secret"), env.INGEST_SECRET) && parsed.data.callsign) {
    callsign = parsed.data.callsign.toUpperCase();
  } else {
    return json({ error: "sign in to register a device key" }, { status: 401 });
  }
  const verified = await isCallsignVerified(env, callsign);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO callsign_keys (callsign, public_key, label, verified, created_at) VALUES (?,?,?,?,?)",
  )
    .bind(callsign, parsed.data.publicKey, parsed.data.label ?? null, verified ? 1 : 0, Math.floor(Date.now() / 1000))
    .run();
  return json({ ok: true, callsign, publicKey: parsed.data.publicKey, verified });
}

export async function handleGetKeys(req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const rows = (
    await env.DB.prepare(
      "SELECT public_key, label, verified, created_at FROM callsign_keys WHERE callsign = ? ORDER BY created_at",
    )
      .bind(cs)
      .all<{ public_key: string; label: string | null; verified: number; created_at: number }>()
  ).results;
  return json({
    callsign: cs,
    keys: rows.map((r) => ({
      publicKey: r.public_key,
      label: r.label,
      verified: r.verified === 1,
      createdAt: r.created_at,
    })),
  });
}

export async function isKeyRegistered(env: Env, callsign: string, publicKey: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM callsign_keys WHERE callsign = ? AND public_key = ?")
    .bind(callsign.toUpperCase(), publicKey)
    .first();
  return !!r;
}

export interface AuthorshipCheck {
  cache: string;
  instance: string;
  logger: string;
  logType: string;
  at: number;
  authorKey: string;
  authorSig: string;
}
/** Verify a logger's signature over the canonical authorship message. */
export async function verifyAuthorship(a: AuthorshipCheck): Promise<boolean> {
  try {
    const key = await importVerifyKey(a.authorKey);
    const msg = new TextEncoder().encode(
      authorshipMessage({ cache: a.cache, instance: a.instance, logger: a.logger, logType: a.logType, at: a.at }),
    );
    return await crypto.subtle.verify("Ed25519", key, fromB64(a.authorSig), msg);
  } catch {
    return false;
  }
}

/**
 * Signed browser ingest. Lets a browser RF station push to a PUBLIC gateway without
 * the shared ingest secret: the batch is signed by the operator's device key (registered to their
 * callsign). Verifies signature + digest + freshness + key registration. Returns the attributed
 * callsign, or null. Trust is unaffected — callers strip the IGate so browser RF stays Tier C.
 */
export async function verifySignedIngest(
  req: Request,
  env: Env,
  packets: unknown[],
): Promise<{ callsign: string } | null> {
  const callsign = (req.headers.get("x-acs-callsign") ?? "").toUpperCase();
  const key = req.headers.get("x-acs-key") ?? "";
  const sig = req.headers.get("x-acs-sig") ?? "";
  const at = Number(req.headers.get("x-acs-at") ?? 0);
  if (!callsign || !key || !sig || !Number.isFinite(at)) return null;
  if (Math.abs(Math.floor(Date.now() / 1000) - at) > 300) return null; // 5-min freshness window
  if (!(await isKeyRegistered(env, callsign, key))) return null; // key must belong to the callsign
  try {
    const digest = await sha256Hex(stableStringify(packets));
    const msg = new TextEncoder().encode(ingestMessage({ callsign, at, count: packets.length, digest }));
    const ok = await crypto.subtle.verify("Ed25519", await importVerifyKey(key), fromB64(sig), msg);
    return ok ? { callsign } : null;
  } catch {
    return null;
  }
}
