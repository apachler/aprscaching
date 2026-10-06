// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GET /ingest/txgate?calls=<call>,…&nonce=<n>[&box=<BOX_ID>] — may this ingest box transmit under these calls?
 *
 * Every transmit port of an ingest box (a KISS TNC, a soundcard port, a MeshCom node) asks before it keys. A call
 * passes when its base call is control-verified, neither the call nor the box's owner is suspended, and the base
 * call is held by whoever operates this box:
 *  - the account that owns the box (boxowner.ts): for a box enrolled for a callsign, that call's holder now;
 *    otherwise the sysop who enrolled it, or the account it was paired with. A revoked box has no owner;
 *  - for the shared INGEST_SECRET, also the instance's operators (the holders of ADMIN_CALLSIGNS, and those calls
 *    themselves): whoever holds the secret runs this instance's backend. The secret names its box with `?box=`
 *    only for a box paired on the secret; a box with its own key speaks only through its signature.
 * A receiving site's call passes on the same terms and no other: its base call is held by the box's operator.
 * A site the sysop trusts, or one FIRST_PARTY_SITES names, vouches for what it hears, never for this box's
 * transmitter, and a site call that has changed hands belongs to its new holder's boxes, not the old one's.
 *
 * For the shared secret the answer carries an HMAC-SHA256 over the box's nonce and the body, keyed with
 * INGEST_SECRET (`x-txgate-mac`). That stops an attacker who can change responses on the way but cannot read
 * requests; over plain http the request itself carries the secret, so a reader on the path can compute the
 * MAC as well. A box whose gateway is not on loopback or its LAN uses https. An enrolled box holds no secret
 * the gateway shares, so it accepts the answer only over https or loopback.
 */
import { baseCall } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import { ingestOrBoxOk, ingestSecretOk, isAdminCall, baseHolder, suspensionOf } from "./auth.js";
import { boxPrincipal } from "./boxprincipal.js";
import { boxHasKey, boxOwner } from "./boxowner.js";
import { adminCalls } from "./admin.js";
import { callSuspended } from "./moderation.js";
import { verificationsOf } from "./callsign.js";
import { json } from "./http.js";

/** Calls per request: a box transmits under a handful. */
const MAX_CALLS = 16;
const CALL_RE = /^[A-Z0-9]{1,6}(?:-(?:1[0-5]|[0-9]))?$/;

interface TxGateAnswer {
  ok: boolean;
  /** Why the call does not pass, when it does not. */
  reason?: string;
}

/** HMAC-SHA256 (hex) of `nonce` and `body` under `secret`: the shared-secret box checks the answer with it. */
async function txGateMac(secret: string, nonce: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${nonce}\n${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleTxGate(req: Request, env: Env): Promise<Response> {
  if (!ingestOrBoxOk(req, env)) return json({ error: "invalid ingest credential" }, { status: 401 });
  const url = new URL(req.url);
  const calls = [
    ...new Set(
      (url.searchParams.get("calls") ?? "")
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (!calls.length || calls.length > MAX_CALLS || !calls.every((c) => CALL_RE.test(c)))
    return json({ error: `calls: 1 to ${MAX_CALLS} callsigns such as OE8APR-10` }, { status: 400 });
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
    return json({ error: "nonce: 16 to 64 letters and digits" }, { status: 400 });

  const principal = boxPrincipal(req);
  const shared = !principal && ingestSecretOk(req, env);
  // an enrolled box is the one that signed; the shared secret names only a box without a key of its own
  const named = url.searchParams.get("box") || null;
  const boxId = principal?.box ?? (named && !(await boxHasKey(env, named)) ? named : null);
  const owner = boxId ? await boxOwner(env, boxId) : null;
  const operators = new Set<string>(owner ? [owner] : []);
  if (shared)
    for (const c of adminCalls(env)) {
      const holder = await baseHolder(env, c);
      if (holder) operators.add(holder);
    }
  const ownerSuspended = owner !== null && !!(await suspensionOf(env, owner));
  const verified = await verificationsOf(env, calls);

  const out: Record<string, TxGateAnswer> = {};
  for (const call of calls) {
    const base = baseCall(call);
    if (ownerSuspended || (await callSuspended(env, call))) {
      out[call] = { ok: false, reason: "suspended" };
      continue;
    }
    if (!verified.has(base)) {
      out[call] = { ok: false, reason: "not control-verified" };
      continue;
    }
    const holder = await baseHolder(env, base);
    const operator = (shared && isAdminCall(env, base)) || (holder !== null && operators.has(holder));
    out[call] = operator ? { ok: true } : { ok: false, reason: "not held by this box's operator" };
  }
  const body = JSON.stringify({ calls: out });
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (shared) headers["x-txgate-mac"] = await txGateMac(env.INGEST_SECRET ?? "", nonce, body);
  return new Response(body, { headers });
}
