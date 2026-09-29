// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * keys.ts — per-callsign device keys. A logger holds an Ed25519 keypair on their device and
 * registers the public key against their callsign. Find logs are then signed by that key, so the
 * authorship of a find is cryptographically attributable to a callsign and verifiable network-wide
 * (not merely asserted by an instance). Whether a key is *authorised* for a callsign is the job of
 * the callsign-control badge: a key reads as verified while its call's base call is control-verified.
 */
import { b64urlToBytes } from "./util/b64.js";
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import {
  RegisterKeyRequest,
  SIG_DOMAIN,
  authorshipMessage,
  ingestMessage,
  sha256Hex,
  stableStringify,
} from "@aprscaching/shared";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { importVerifyKey, verifyDomain } from "./federation.js";
import { isCallsignVerified } from "./callsign.js";
import { sessionIdentity, accountHoldsCall } from "./auth.js";

export async function handleRegisterKey(req: Request, env: Env): Promise<Response> {
  const parsed = RegisterKeyRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  // Registering a key BINDS it to a callsign, and account.ts authorises destructive account actions
  // (export/delete/bundle/move) and signed ingest by a registered key — so only the signed-in holder
  // registers, for a base call their account holds (any SSID of it). No machine secret registers a key:
  // whoever holds the ingest secret must not be able to bind a key to someone else's call.
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to register a device key" }, { status: 401 });
  const callsign = (parsed.data.callsign ?? me.callsign).toUpperCase();
  if (!(await accountHoldsCall(env, me.accountId, callsign)))
    return json({ error: "callsign is not yours" }, { status: 403 });
  await env.DB.prepare("INSERT OR IGNORE INTO callsign_keys (callsign, public_key, label, created_at) VALUES (?,?,?,?)")
    .bind(callsign, parsed.data.publicKey, parsed.data.label ?? null, nowS())
    .run();
  const verified = await isCallsignVerified(env, callsign);
  return json({ ok: true, callsign, publicKey: parsed.data.publicKey, verified });
}

export async function handleGetKeys(req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const rows = (
    await env.DB.prepare(
      "SELECT public_key, label, created_at FROM callsign_keys WHERE callsign = ? ORDER BY created_at",
    )
      .bind(cs)
      .all<{ public_key: string; label: string | null; created_at: number }>()
  ).results;
  const verified = await isCallsignVerified(env, cs);
  return json({
    callsign: cs,
    keys: rows.map((r) => ({
      publicKey: r.public_key,
      label: r.label,
      verified,
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
    return await crypto.subtle.verify("Ed25519", key, b64urlToBytes(a.authorSig), msg);
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
  if (Math.abs(nowS() - at) > 300) return null; // 5-min freshness window
  if (!(await isKeyRegistered(env, callsign, key))) return null; // key must belong to the callsign
  try {
    const digest = await sha256Hex(stableStringify(packets));
    const ok = await verifyDomain(
      await importVerifyKey(key),
      b64urlToBytes(sig),
      SIG_DOMAIN.ingest,
      ingestMessage({ callsign, at, count: packets.length, digest }),
    );
    if (!ok) return null;
    // a signed batch is accepted once: the same (key, time, content) inside the freshness window is a
    // replay, remembered for as long as the window lasts
    const once = await sha256Hex(`${key}|${at}|${digest}`);
    if (await rateLimitedDurable(env, `ingest-once:${once}`, Date.now(), 1, 600_000)) return null;
    return { callsign };
  } catch {
    return null;
  }
}
