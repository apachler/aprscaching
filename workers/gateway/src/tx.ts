// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { sessionIdentity } from "./auth.js";
import { isCallsignVerified } from "./callsign.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { encodeAprsMessage, encodeAprsPosition, isAprsSymbol } from "@aprscaching/aprs";

/**
 * tx.ts — gated user TX via the ingest box. A signed-in, control-verified user asks the peer to inject
 * a beacon or message into APRS-IS **under the user's own call** as third-party traffic (`}USERCALL>…`;
 * the ingest box does the encapsulation on drain — see announce.ts). The gate is our control-verification
 * — never a passcode (transport ≠ authorization). We enqueue to `aprs_outbox` with
 * `src_call` = the verified user call; the box drains + injects. RF legality holds:
 * the wire source is a real, control-verified licensed call.
 */
interface UserTxBody {
  kind?: string;
  addressee?: string;
  text?: string;
  lat?: number;
  lon?: number;
  symbol?: string;
  comment?: string;
  tocall?: string;
  msgNo?: string;
}

/** A TOCALL a client may name: a callsign-shaped destination, 1–6 letters or digits and an optional SSID. */
const TOCALL = /^[A-Z0-9]{1,6}(-\d{1,2})?$/;
/** An APRS message addressee: the 9-character field, a callsign with an optional SSID. */
const ADDRESSEE = /^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$/;
/** An APRS message number. */
const MSG_NO = /^[A-Za-z0-9]{1,5}$/;
/** The longest APRS message text. */
const APRS_MESSAGE_MAX = 67;

/** User transmissions an account may queue an hour. */
export const TX_PER_HOUR = 30;

/**
 * Pure: validate a user-TX request and build the outbox row fields (kind + APRS info payload). Returns an
 * error string for a bad request. No auth/DB here — the handler gates on control-verification first.
 */
export function buildTxPayload(body: UserTxBody):
  | {
      ok: true;
      kind: string;
      payload: string;
      tocall: string;
      /** For a message: what the Messages list records as sent. */
      message?: { to: string; text: string; msgNo: string | null };
    }
  | { ok: false; error: string } {
  const kind = String(body.kind ?? "").toLowerCase();
  const tocall = String(body.tocall ?? "APZACG").toUpperCase(); // default self-assigned TOCALL
  if (!TOCALL.test(tocall)) return { ok: false, error: "tocall must be 1–6 letters or digits, with an optional SSID" };
  if (kind === "message") {
    const to = String(body.addressee ?? "")
      .toUpperCase()
      .trim();
    const text = String(body.text ?? "").trim();
    if (!to || !text) return { ok: false, error: "a message needs an addressee and text" };
    if (!ADDRESSEE.test(to)) return { ok: false, error: "the addressee must be a callsign of up to 9 characters" };
    if (text.length > APRS_MESSAGE_MAX)
      return { ok: false, error: `an APRS message holds at most ${APRS_MESSAGE_MAX} characters` };
    // a message number asks the addressee's station to acknowledge it
    const msgNo = body.msgNo == null || body.msgNo === "" ? undefined : String(body.msgNo);
    if (msgNo !== undefined && !MSG_NO.test(msgNo)) return { ok: false, error: "msgNo must be 1–5 letters or digits" };
    return {
      ok: true,
      kind: "message",
      payload: encodeAprsMessage(to, text, msgNo),
      tocall,
      message: { to, text, msgNo: msgNo ?? null },
    };
  }
  if (kind === "beacon") {
    const lat = Number(body.lat),
      lon = Number(body.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return { ok: false, error: "a beacon needs a valid lat/lon" };
    const symbol = String(body.symbol ?? "/>");
    if (!isAprsSymbol(symbol)) return { ok: false, error: "symbol must be two printable ASCII characters" };
    return {
      ok: true,
      kind: "beacon",
      payload: encodeAprsPosition(lat, lon, symbol, String(body.comment ?? "").slice(0, 120)),
      tocall,
    };
  }
  return { ok: false, error: "kind must be 'message' or 'beacon'" };
}

export async function handleUserTx(req: Request, env: Env): Promise<Response> {
  // The session resolves only while its account holds the call's base; control-verification lives on
  // the BASE call, which every SSID of it inherits.
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to transmit" }, { status: 401 });
  const callsign = me.callsign.toUpperCase();
  if (!(await isCallsignVerified(env, me.base))) {
    return json({ error: `verify ${me.base} to transmit — control-verification required` }, { status: 403 });
  }
  const built = buildTxPayload((await req.json().catch(() => ({}))) as UserTxBody);
  if (!built.ok) return json({ error: built.error }, { status: 400 });
  if (await rateLimitedDurable(env, `tx:${me.accountId}`, Date.now(), TX_PER_HOUR, 3600_000))
    return json({ error: `at most ${TX_PER_HOUR} transmissions an hour` }, { status: 429 });

  const ins = await env.DB.prepare(
    "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload, target) VALUES (?,?,?,?,?, 'is')",
  )
    .bind(nowS(), callsign, built.tocall, built.kind, built.payload)
    .run();
  const id = Number(ins.meta.last_row_id);
  // A message joins the sender's conversation as sent through APRS-IS; its outbox row says whether it went out,
  // and the recipient's ack, when the instance hears it, marks it acknowledged.
  if (built.message)
    await env.DB.prepare(
      "INSERT INTO messages (ts, from_call, to_call, body, ack, direction, transport, outbox_id) VALUES (?,?,?,?,?, 'tx', 'aprs-is', ?)",
    )
      .bind(nowS(), callsign, built.message.to, built.message.text, built.message.msgNo, id)
      .run();
  return json({ id, srcCall: callsign, kind: built.kind, tocall: built.tocall, status: "queued" }, { status: 201 });
}
