// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GET /ingest/txgate?calls=<call>,…&nonce=<n>[&box=<BOX_ID>] — may this ingest box transmit under these calls?
 *
 * Every transmit port of an ingest box (a KISS TNC, a soundcard port) asks before it keys. A call passes when
 * its base call is control-verified AND it belongs to whoever operates this box:
 *  - the account that owns the box (`boxes`: the sysop who enrolled it, or the account it was paired with);
 *  - the operator of a receiving site of the box's own: an enrolled box's trusted sites, or for the shared
 *    secret the instance's own attested sites (FIRST_PARTY_SITES). The trusted stations a sysop adds by call
 *    vouch for what they hear, not for this box's transmitter, so another ham's site call never passes;
 *  - for the shared INGEST_SECRET, the instance's own operator calls (ADMIN_CALLSIGNS): whoever holds the
 *    secret runs this instance's backend.
 * A verified call of somebody else therefore never opens a box's transmitter.
 *
 * For the shared secret the answer carries an HMAC-SHA256 over the box's nonce and the body, keyed with
 * INGEST_SECRET (`x-txgate-mac`). That stops an attacker who can change responses on the way but cannot read
 * requests; over plain http the request itself carries the secret, so a reader on the path can compute the
 * MAC as well. A box whose gateway is not on loopback or its LAN uses https. An enrolled box holds no secret
 * the gateway shares, so it accepts the answer only over https or loopback.
 */
import { baseCall } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import { ingestOrBoxOk, ingestSecretOk, isAdminCall, baseHolder } from "./auth.js";
import { boxPrincipal } from "./boxprincipal.js";
import { attestation, sitesFor } from "./attestedsites.js";
import { parseAttestedSites } from "./provenance.js";
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
  // the shared secret names its box; an enrolled box is the one that signed
  const boxId = principal?.box ?? (url.searchParams.get("box") || null);
  const owner = boxId
    ? ((
        await env.DB.prepare("SELECT account_id FROM boxes WHERE box_id = ?")
          .bind(boxId)
          .first<{ account_id: string }>()
      )?.account_id ?? null)
    : null;
  const sites = principal ? sitesFor(await attestation(env), principal.box) : parseAttestedSites(env.FIRST_PARTY_SITES);
  const siteBases = new Set([...sites].map(baseCall));
  const verified = await verificationsOf(env, calls);

  const out: Record<string, TxGateAnswer> = {};
  for (const call of calls) {
    const base = baseCall(call);
    if (!verified.has(base)) {
      out[call] = { ok: false, reason: "not control-verified" };
      continue;
    }
    const operator =
      siteBases.has(base) ||
      (shared && isAdminCall(env, base)) ||
      (owner !== null && (await baseHolder(env, base)) === owner);
    out[call] = operator ? { ok: true } : { ok: false, reason: "not held by this box's operator" };
  }
  const body = JSON.stringify({ calls: out });
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (shared) headers["x-txgate-mac"] = await txGateMac(env.INGEST_SECRET ?? "", nonce, body);
  return new Response(body, { headers });
}
