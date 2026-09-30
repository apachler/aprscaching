// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fed44net.ts — verified peer onboarding over 44net (AMPRNet). ARDC's portal reviews a ham's licence
 * before delegating `<call>.ampr.org` (its Level-of-Trust process), so a name under that zone is an
 * externally-verified callsign↔person binding. A peer advertises its federation identity in DNS:
 *
 *   _aprscaching.<call>.ampr.org  TXT  "v=acs1; inst=<instance-id>; key=<b64url raw Ed25519>[; host=<name>]"
 *
 * The peer is contacted at `http://<call>.ampr.org`, or at `host=` when the record names one. `host=` must
 * be `<call>.ampr.org` itself or a name under it: a TXT in one callsign's zone must not point federation
 * traffic at a third party, so any other host rejects the whole record. It moves where the peer is
 * reached, never who it is (the callsign), its key pin or its trust.
 *
 * Onboarding cross-checks four facts: the name exists under ampr.org (ARDC reviewed the licence),
 * the TXT binds an instance id + signing key, the peer's descriptor verifies under that key (checked
 * at admission when reachable, and enforced on every sync by the key pin), and — when the resolver
 * validates the zone with DNSSEC (the AD flag) — the binding is cryptographically anchored, so the
 * peer is admitted automatically. Without DNSSEC the operator confirms once (a TOFU pin).
 *
 * What this attests is IDENTITY only: the peer enters `unvetted` like any discovered peer, and the
 * operator-set trust tier still governs whether its records count — transport is never trust.
 */
import { nowS } from "./util/time.js";
import { fedFetch } from "./fetchguard.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { activeFedKeys, isInstanceId, type FedPublicKey } from "./federation.js";
import { resolveTxt, acsFields, amprNames } from "./doh.js";

const RESOLVE_TIMEOUT_MS = 5000;
const BASE_CALL_RE = /^[A-Za-z0-9]{3,9}$/;

interface Resolved44net {
  callsign: string; // base call, uppercased
  host: string; // where the peer is contacted: host= from the TXT, else <call>.ampr.org
  instance: string;
  publicKey: string; // b64url raw Ed25519 from the TXT
  dnssec: boolean; // the resolver validated the chain (AD flag)
}

const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host a `host=` value names, lowercased, when it is `zone` itself or a name under it and a valid
 * hostname (labels of 1–63 letters, digits and inner hyphens, 253 characters at most, no trailing dot);
 * otherwise null.
 */
export function hostInZone(value: string, zone: string): string | null {
  const host = value.toLowerCase();
  if (host.length > 253 || !host.split(".").every((l) => HOST_LABEL_RE.test(l))) return null;
  return host === zone || host.endsWith(`.${zone}`) ? host : null;
}

/**
 * Parse the `v=acs1; inst=…; key=…[; host=…]` TXT payload found under `callsign`'s zone. Returns null for
 * anything else, including a `host=` outside `<call>.ampr.org`.
 */
export function parse44netTxt(
  txt: string,
  callsign: string,
): { instance: string; publicKey: string; host: string } | null {
  const fields = acsFields(txt);
  if (!fields) return null;
  const instance = fields.get("inst");
  const publicKey = fields.get("key");
  if (!instance || !publicKey || !/^[A-Za-z0-9_-]{40,50}$/.test(publicKey)) return null; // 32-byte key, b64url
  const zone = amprNames(callsign).host;
  const declared = fields.get("host");
  const host = declared === undefined ? zone : hostInZone(declared, zone);
  if (!host) return null;
  return { instance, publicKey, host };
}

/**
 * Resolve a callsign's federation TXT via DNS-over-HTTPS (doh.ts); the answer carries the resolver's
 * DNSSEC-validated AD flag.
 */
export async function resolve44net(env: Env, callsign: string): Promise<Resolved44net> {
  const cs = callsign.trim().toUpperCase();
  if (!BASE_CALL_RE.test(cs)) throw new Error("a base callsign is required (letters/digits, no SSID)");
  const { name } = amprNames(cs);
  const ans = await resolveTxt(env, name);
  if (ans.status !== 0) throw new Error(`no ${name} TXT record (DNS status ${ans.status})`);
  for (const txt of ans.txts) {
    const parsed = parse44netTxt(txt, cs);
    if (parsed) return { callsign: cs, ...parsed, dnssec: ans.dnssec };
  }
  throw new Error(
    `no valid aprscaching TXT at ${name} (expect "v=acs1; inst=…; key=…", with any host= under ${amprNames(cs).host})`,
  );
}

/**
 * Cross-check the DNS-advertised binding against the peer's live descriptor when it is reachable:
 * the declared instance id must match and the DNS key must be among the descriptor's active keys.
 * An unreachable peer is not fatal (44net space may not route from here) — the DNS key becomes the
 * pin, and every future sync verifies against exactly that key or a signed rotation from it.
 */
async function descriptorMatches(
  env: Env,
  baseUrl: string,
  expected: { instance: string; publicKey: string },
): Promise<{ checked: boolean; ok: boolean; detail?: string }> {
  try {
    const res = await fedFetch(env, `${baseUrl}/.well-known/aprscaching`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!res.ok) return { checked: false, ok: true, detail: `descriptor unreachable (${res.status})` };
    const wk = (await res.json()) as { instance?: string; publicKeys?: FedPublicKey[] };
    const keys = activeFedKeys(Array.isArray(wk.publicKeys) ? wk.publicKeys : [], nowS());
    if (wk.instance !== expected.instance)
      return {
        checked: true,
        ok: false,
        detail: `descriptor instance '${wk.instance}' != DNS 'inst=${expected.instance}'`,
      };
    if (!keys.includes(expected.publicKey))
      return { checked: true, ok: false, detail: "the DNS-advertised key is not among the descriptor's active keys" };
    return { checked: true, ok: true };
  } catch {
    return { checked: false, ok: true, detail: "descriptor unreachable" };
  }
}

/**
 * POST /federation/peers/44net — sysop-only. Body { callsign, confirm? }. Resolves the callsign's
 * federation TXT, cross-checks the descriptor, and admits the peer as `unvetted` when the binding is
 * DNSSEC-validated OR the operator confirms; otherwise returns the resolved binding for a one-click
 * confirm. A `blocked` peer is never resurrected by re-adding.
 */
export async function handleFed44netAdd(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true }); // same gate as the peer-trust surface
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as { callsign?: string; confirm?: boolean };
  let resolved: Resolved44net;
  try {
    resolved = await resolve44net(env, String(body.callsign ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 });
  }
  const url = `http://${resolved.host}`; // amateur IP space: plain http; authenticity is in signatures
  const desc = await descriptorMatches(env, url, resolved);
  if (desc.checked && !desc.ok)
    return json({ error: `44net binding mismatch: ${desc.detail}`, resolved }, { status: 409 });

  if (!resolved.dnssec && !body.confirm) {
    // no DNSSEC anchor → the operator pins the binding explicitly (trust-on-first-use)
    return json({ requiresConfirm: true, resolved, descriptorChecked: desc.checked });
  }

  // the instance id binds to one live peer row: never rename a known row, never share an id
  if (!isInstanceId(resolved.instance))
    return json({ error: "44net descriptor names an invalid instance id", resolved }, { status: 409 });
  const bound = await env.DB.prepare(
    "SELECT url, instance FROM fed_peers WHERE (url = ? AND instance IS NOT NULL AND instance != ?) OR (url != ? AND instance = ? AND trust != 'blocked')",
  )
    .bind(url, resolved.instance, url, resolved.instance)
    .first<{ url: string; instance: string }>();
  if (bound)
    return json(
      { error: `instance binding conflict with ${bound.url} (${bound.instance}) — block or remove it first`, resolved },
      { status: 409 },
    );

  const endpoints = JSON.stringify([
    { transport: "44net", address: resolved.host, priority: 10, verifiedVia: "ardc-lot" },
  ]);
  await env.DB.prepare(
    `INSERT INTO fed_peers (url, instance, public_key, trust, added_via, verified_via, endpoints, approved_at)
     VALUES (?,?,?, 'unvetted', '44net', 'ardc-lot', ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       instance     = COALESCE(fed_peers.instance, excluded.instance),
       public_key   = COALESCE(fed_peers.public_key, excluded.public_key),
       verified_via = 'ardc-lot',
       endpoints    = excluded.endpoints,
       trust        = fed_peers.trust`, // an existing tier (incl. 'blocked') is never changed by re-adding
  )
    .bind(url, resolved.instance, resolved.publicKey, endpoints, nowS())
    .run();
  return json(
    {
      ok: true,
      admitted: resolved.dnssec ? "dnssec" : "operator-confirmed",
      peer: { url, instance: resolved.instance, callsign: resolved.callsign, trust: "unvetted" },
      descriptorChecked: desc.checked,
    },
    { status: 201 },
  );
}
