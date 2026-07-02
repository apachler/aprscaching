// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionCallsign } from "./auth.js";
import { isCallsignVerified } from "./callsign.js";
import { encodeAprsMessage, encodeAprsPosition } from "@aprsweb/aprs";

/**
 * tx.ts — path-A gated user TX. A signed-in, control-verified user asks the peer to inject
 * a beacon or message into APRS-IS **under the user's own call** as third-party traffic (`}USERCALL>…`;
 * the ingest box does the encapsulation on drain — see announce.ts). The gate is our control-verification
 * (H5) — never a passcode (transport ≠ authorization). We enqueue to `aprs_outbox` with
 * `src_call` = the verified user call; the box drains + injects (validate-at-deploy). RF legality holds:
 * the wire source is a real, control-verified licensed call.
 */
export interface UserTxBody {
  kind?: string; addressee?: string; text?: string; lat?: number; lon?: number; symbol?: string; comment?: string; tocall?: string;
}

/**
 * Pure: validate a user-TX request and build the outbox row fields (kind + APRS info payload). Returns an
 * error string for a bad request. No auth/DB here — the handler gates on control-verification first.
 */
export function buildTxPayload(body: UserTxBody): { ok: true; kind: string; payload: string; tocall: string } | { ok: false; error: string } {
  const kind = String(body.kind ?? "").toLowerCase();
  const tocall = String(body.tocall ?? "APZACG").toUpperCase();   // TOCALL config lands with P1
  if (kind === "message") {
    const to = String(body.addressee ?? "").toUpperCase().trim();
    const text = String(body.text ?? "").trim();
    if (!to || !text) return { ok: false, error: "a message needs an addressee and text" };
    return { ok: true, kind: "message", payload: encodeAprsMessage(to, text), tocall };
  }
  if (kind === "beacon") {
    const lat = Number(body.lat), lon = Number(body.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, error: "a beacon needs a valid lat/lon" };
    return { ok: true, kind: "beacon", payload: encodeAprsPosition(lat, lon, String(body.symbol ?? "/>"), String(body.comment ?? "").slice(0, 120)), tocall };
  }
  return { ok: false, error: "kind must be 'message' or 'beacon'" };
}

export async function handleUserTx(req: Request, env: Env): Promise<Response> {
  const callsign = (await sessionCallsign(req, env))?.toUpperCase();
  if (!callsign) return json({ error: "sign in to transmit" }, { status: 401 });
  if (!(await isCallsignVerified(env, callsign))) {
    return json({ error: `verify ${callsign} to transmit — control-verification required (H5)` }, { status: 403 });
  }
  const built = buildTxPayload((await req.json().catch(() => ({}))) as UserTxBody);
  if (!built.ok) return json({ error: built.error }, { status: 400 });

  const ins = await env.DB.prepare(
    "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload, target) VALUES (?,?,?,?,?, 'is')",
  ).bind(Math.floor(Date.now() / 1000), callsign, built.tocall, built.kind, built.payload).run();
  return json({ id: Number(ins.meta.last_row_id), srcCall: callsign, kind: built.kind, tocall: built.tocall, status: "queued" }, { status: 201 });
}
