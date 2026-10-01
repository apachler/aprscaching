// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * boxkeys.ts — ingest boxes with their own keys. The sysop creates a one-time enrollment code; the box
 * presents it once with a freshly generated Ed25519 key and from then on signs every request to the gateway
 * with that key instead of sending the shared INGEST_SECRET. One box is revoked on its own, and boxes on the
 * shared secret keep working beside enrolled ones.
 *
 *   POST /api/admin/boxes/codes        create a code {label?, callsign?, ttlMin?} → {code, expiresAt} (sysop)
 *   GET  /api/admin/boxes              enrolled boxes and the codes still open (sysop)
 *   POST /api/admin/boxes/:id/revoke   revoke a box's key (sysop)
 *   POST /ingest/enroll                a box enrolls: {code, box, key, at, sig} → {box, instance, label, callsign}
 *
 * A signed request carries x-box-id, x-box-at (unix seconds), x-box-nonce and x-box-sig, an Ed25519
 * signature over boxRequestMessage (packages/shared canon.ts): method, path with query, time, nonce and the
 * body's SHA-256. It is fresh for five minutes and accepted once. route() verifies it before any handler
 * runs; a request it verifies holds the ingest plane's rights (ingestSecretOk), scoped to that box where an
 * endpoint names a box.
 *
 * Trust is unchanged: an enrolled box is an ingest credential, never an attestation. What it hears counts
 * for Tier A only when the sysop lists its receiving site in FIRST_PARTY_SITES, as for a box on the shared
 * secret. A box enrolled for a callsign is narrower still: it may name only sites of that base call.
 */
import { SIG_DOMAIN, boxEnrollMessage, boxRequestMessage } from "@aprscaching/shared";
import { baseCall } from "@aprscaching/aprs";
import { b64urlToBytes } from "./util/b64.js";
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { sessionIdentity } from "./auth.js";
import { clientIp, rateLimitedDurable } from "./corroborate_privacy.js";
import { importVerifyKey, verifyDomain } from "./federation.js";
import { boxPrincipal, setBoxPrincipal } from "./boxprincipal.js";

/** A signature is fresh this long either side of the gateway's clock. */
const FRESH_S = 300;
/** Codes last 10–15 minutes: long enough to type on the box, short enough not to linger. */
const CODE_TTL_MIN = 10;
const CODE_TTL_MAX = 15;
/** Enrollment attempts per client address per window, and in all per window: a code has 80 bits besides. */
const ENROLL_PER_IP = 10;
const ENROLL_ALL = 60;
const ENROLL_WINDOW_MS = 15 * 60_000;
/** Upper-case letters and digits without the look-alikes 0/O and 1/I: 32 symbols, 5 bits each. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BOX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CALL = /^[A-Z0-9]{3,9}$/;

const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A 16-symbol code (80 bits) in four groups: ABCD-EFGH-JKLM-NPQR. */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const s = [...bytes].map((b) => ALPHABET[b % 32]!).join("");
  return s.match(/.{4}/g)!.join("-");
}

/** Who acted, for the record: the sysop's account, or 'operator' for the OPERATOR_SECRET. */
async function actor(req: Request, env: Env): Promise<string> {
  return (await sessionIdentity(req, env))?.accountId ?? "operator";
}

// ---- admin ----------------------------------------------------------------------------------------------

/** POST /api/admin/boxes/codes — a one-time enrollment code, shown once. */
export async function handleCreateEnrollCode(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const b = ((await req.json().catch(() => ({}))) ?? {}) as { label?: unknown; callsign?: unknown; ttlMin?: unknown };
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 64) || null : null;
  const callsign =
    typeof b.callsign === "string" && b.callsign.trim() ? baseCall(b.callsign.trim().toUpperCase()) : null;
  if (callsign && !CALL.test(callsign)) return json({ error: "callsign is not a callsign" }, { status: 400 });
  const ttlMin = Math.min(CODE_TTL_MAX, Math.max(CODE_TTL_MIN, Math.round(Number(b.ttlMin) || CODE_TTL_MAX)));
  const code = newCode();
  const now = nowS();
  const expiresAt = now + ttlMin * 60;
  await env.DB.prepare(
    `INSERT INTO box_enrollment_codes (code_hash, label, callsign, created_by, created_at, expires_at)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(await sha256Hex(normCode(code)), label, callsign, await actor(req, env), now, expiresAt)
    .run();
  return json({ code, expiresAt, label, callsign }, { status: 201 });
}

/** GET /api/admin/boxes — the enrolled boxes and the codes still open (never a code or its hash). */
export async function handleListBoxes(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const boxes = await env.DB.prepare(
    `SELECT box_id AS box, label, callsign, enrolled_by AS enrolledBy, enrolled_at AS enrolledAt,
            revoked_by AS revokedBy, revoked_at AS revokedAt, last_seen_at AS lastSeenAt
       FROM box_keys ORDER BY enrolled_at DESC`,
  ).all();
  const open = await env.DB.prepare(
    `SELECT label, callsign, created_at AS createdAt, expires_at AS expiresAt
       FROM box_enrollment_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
  )
    .bind(nowS())
    .all();
  return json({ boxes: boxes.results ?? [], openCodes: open.results ?? [] });
}

/** POST /api/admin/boxes/:id/revoke — the box's key stops verifying at once. */
export async function handleRevokeBox(req: Request, env: Env, box: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const r = await env.DB.prepare(
    "UPDATE box_keys SET revoked_at = ?, revoked_by = ? WHERE box_id = ? AND revoked_at IS NULL",
  )
    .bind(nowS(), await actor(req, env), box)
    .run();
  if (!r.meta?.changes)
    return json({ error: "no enrolled box with that id, or it is revoked already" }, { status: 404 });
  return json({ box, revoked: true });
}

// ---- enrollment -----------------------------------------------------------------------------------------

/**
 * POST /ingest/enroll — a box trades a one-time code for its place in box_keys. It proves it holds the key
 * by signing the request with it. The code is consumed in one statement, so two boxes racing for one code
 * cannot both win.
 */
export async function handleEnroll(req: Request, env: Env): Promise<Response> {
  const nowMs = Date.now();
  if (
    (await rateLimitedDurable(env, `box-enroll:${clientIp(req, env)}`, nowMs, ENROLL_PER_IP, ENROLL_WINDOW_MS)) ||
    (await rateLimitedDurable(env, "box-enroll:all", nowMs, ENROLL_ALL, ENROLL_WINDOW_MS))
  )
    return json({ error: "too many enrollment attempts; wait a few minutes" }, { status: 429 });
  const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const code = typeof b.code === "string" ? normCode(b.code) : "";
  const key = typeof b.key === "string" ? b.key : "";
  const sig = typeof b.sig === "string" ? b.sig : "";
  const at = Number(b.at);
  const box = typeof b.box === "string" ? b.box : "";
  if (code.length !== 16 || !box || !key || !sig || !Number.isFinite(at))
    return json({ error: "code, box, key, at and sig are required" }, { status: 400 });
  if (!BOX_ID.test(box)) return json({ error: "box ids are letters, digits, '.', '_' and '-'" }, { status: 400 });
  if (Math.abs(nowS() - at) > FRESH_S)
    return json({ error: "the box's clock is off by more than five minutes" }, { status: 400 });
  try {
    const ok = await verifyDomain(
      await importVerifyKey(key),
      b64urlToBytes(sig),
      SIG_DOMAIN.boxEnroll,
      boxEnrollMessage({ box, key, code, at }),
    );
    if (!ok) return json({ error: "the signature does not match the key" }, { status: 400 });
  } catch {
    return json({ error: "the key or the signature is malformed" }, { status: 400 });
  }
  const live = await env.DB.prepare("SELECT 1 AS x FROM box_keys WHERE box_id = ? AND revoked_at IS NULL")
    .bind(box)
    .first();
  if (live)
    return json({ error: "a box with this id is enrolled; revoke it first, or choose another id" }, { status: 409 });

  const now = nowS();
  const used = await env.DB.prepare(
    `UPDATE box_enrollment_codes SET used_at = ?, box_id = ?
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING label, callsign, created_by AS createdBy`,
  )
    .bind(now, box, await sha256Hex(code), now)
    .first<{ label: string | null; callsign: string | null; createdBy: string }>();
  if (!used) return json({ error: "the code is wrong, used or expired" }, { status: 403 });

  // A revoked box enrolls anew under its id with the fresh key.
  await env.DB.prepare(
    `INSERT INTO box_keys (box_id, public_key, label, callsign, enrolled_by, enrolled_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(box_id) DO UPDATE SET public_key = excluded.public_key, label = excluded.label,
       callsign = excluded.callsign, enrolled_by = excluded.enrolled_by, enrolled_at = excluded.enrolled_at,
       revoked_by = NULL, revoked_at = NULL, last_seen_at = NULL`,
  )
    .bind(
      box,
      key,
      used.label ?? (typeof b.label === "string" ? b.label.slice(0, 64) : null),
      used.callsign,
      used.createdBy,
      now,
    )
    .run();
  // The sysop who let the box in owns it for remote control, replacing the separate pairing step; a box
  // another account already owns keeps its owner.
  if (used.createdBy !== "operator")
    await env.DB.prepare("INSERT OR IGNORE INTO boxes (box_id, account_id, created_at) VALUES (?,?,?)")
      .bind(box, used.createdBy, now)
      .run();
  console.log(`box ${box} enrolled by ${used.createdBy}${used.callsign ? ` for ${used.callsign}` : ""}`);
  return json({ box, instance: env.INSTANCE ?? null, label: used.label, callsign: used.callsign }, { status: 201 });
}

// ---- signed requests ------------------------------------------------------------------------------------

/**
 * Verify a box's signed request and remember its principal for the handlers. A request without the
 * headers is left alone; one whose signature does not verify is left unauthenticated, so the handler
 * answers it as it would any request without a credential.
 */
export async function authenticateBox(req: Request, env: Env): Promise<void> {
  const box = req.headers.get("x-box-id");
  const sig = req.headers.get("x-box-sig");
  if (!box || !sig) return;
  const at = Number(req.headers.get("x-box-at"));
  const nonce = req.headers.get("x-box-nonce") ?? "";
  if (!Number.isFinite(at) || Math.abs(nowS() - at) > FRESH_S || nonce.length < 16) return;
  try {
    const row = await env.DB.prepare(
      "SELECT public_key, callsign, last_seen_at FROM box_keys WHERE box_id = ? AND revoked_at IS NULL",
    )
      .bind(box)
      .first<{ public_key: string; callsign: string | null; last_seen_at: number | null }>();
    if (!row) return;
    const url = new URL(req.url);
    const body = new Uint8Array(await req.clone().arrayBuffer());
    const ok = await verifyDomain(
      await importVerifyKey(row.public_key),
      b64urlToBytes(sig),
      SIG_DOMAIN.box,
      boxRequestMessage({
        box,
        method: req.method,
        path: url.pathname + url.search,
        at,
        nonce,
        digest: await sha256Hex(body),
      }),
    );
    if (!ok) return;
    // each signature once: a copy replayed inside the freshness window is refused
    if (await rateLimitedDurable(env, `box-once:${await sha256Hex(sig)}`, Date.now(), 1, 2 * FRESH_S * 1000)) return;
    setBoxPrincipal(req, { box, callsign: row.callsign });
    const now = nowS();
    if (!row.last_seen_at || now - row.last_seen_at > 300)
      await env.DB.prepare("UPDATE box_keys SET last_seen_at = ? WHERE box_id = ?").bind(now, box).run();
  } catch {
    // a malformed key, signature or body leaves the request unauthenticated
  }
}

/**
 * Whether the signer of this request may act as box `id` on an endpoint that names a box: a box signs only
 * for itself; the shared secret and the operator act for any box.
 */
export function boxMayActAs(req: Request, id: string): boolean {
  const p = boxPrincipal(req);
  return !p || p.box === id;
}

/**
 * A box enrolled for a callsign may name only receiving sites of that base call: a site call (IGate or
 * receiver) of another call is dropped from its packets, so it can neither attest nor route through
 * another operator's site.
 */
export function siteAllowed(req: Request, site: string | null | undefined): boolean {
  const p = boxPrincipal(req);
  if (!p?.callsign || !site) return true;
  return baseCall(site.toUpperCase()) === p.callsign;
}
