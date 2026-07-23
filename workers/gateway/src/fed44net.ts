// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fed44net.ts — verified peer onboarding over 44net (AMPRNet). ARDC's portal reviews a ham's licence
 * before delegating `<call>.ampr.org` (its Level-of-Trust process), so a name under that zone is an
 * externally-verified callsign↔person binding. A peer advertises its federation identity in DNS:
 *
 *   _aprscaching.<call>.ampr.org  TXT  "v=acs1; inst=<instance-id>; key=<b64url raw Ed25519>"
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
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { activeFedKeys, type FedPublicKey } from "./federation.js";

const DEFAULT_DOH = "https://cloudflare-dns.com/dns-query";
const RESOLVE_TIMEOUT_MS = 5000;
const BASE_CALL_RE = /^[A-Za-z0-9]{3,9}$/;

export interface Resolved44net {
  callsign: string; // base call, uppercased
  host: string; // <call>.ampr.org
  instance: string;
  publicKey: string; // b64url raw Ed25519 from the TXT
  dnssec: boolean; // the resolver validated the chain (AD flag)
}

/** Parse the `v=acs1; inst=…; key=…` TXT payload. Returns null for anything else. */
export function parse44netTxt(txt: string): { instance: string; publicKey: string } | null {
  const fields = new Map<string, string>();
  for (const part of txt.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  if (fields.get("v") !== "acs1") return null;
  const instance = fields.get("inst");
  const publicKey = fields.get("key");
  if (!instance || !publicKey || !/^[A-Za-z0-9_-]{40,50}$/.test(publicKey)) return null; // 32-byte key, b64url
  return { instance, publicKey };
}

interface DohAnswer {
  Status: number;
  AD?: boolean;
  Answer?: { name: string; type: number; data: string }[];
}

/**
 * Resolve a callsign's federation TXT via DNS-over-HTTPS (runtime-neutral — plain fetch works on
 * Workers, Node and Bun alike; the JSON answer carries the resolver's DNSSEC-validated AD flag).
 */
export async function resolve44net(env: Env, callsign: string): Promise<Resolved44net> {
  const cs = callsign.trim().toUpperCase();
  if (!BASE_CALL_RE.test(cs)) throw new Error("a base callsign is required (letters/digits, no SSID)");
  const host = `${cs.toLowerCase()}.ampr.org`;
  const name = `_aprscaching.${host}`;
  const doh = (env.DOH_URL || DEFAULT_DOH).replace(/\/+$/, "");
  const res = await fetch(`${doh}?name=${encodeURIComponent(name)}&type=TXT`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DNS resolver ${res.status}`);
  const ans = (await res.json()) as DohAnswer;
  if (ans.Status !== 0) throw new Error(`no ${name} TXT record (DNS status ${ans.Status})`);
  for (const a of ans.Answer ?? []) {
    if (a.type !== 16) continue;
    // TXT data arrives as one or more quoted chunks — unquote and join
    const txt = a.data.replace(/^"|"$/g, "").replace(/"\s+"/g, "");
    const parsed = parse44netTxt(txt);
    if (parsed) return { callsign: cs, host, instance: parsed.instance, publicKey: parsed.publicKey, dnssec: !!ans.AD };
  }
  throw new Error(`no valid aprscaching TXT at ${name} (expect "v=acs1; inst=…; key=…")`);
}

/**
 * Cross-check the DNS-advertised binding against the peer's live descriptor when it is reachable:
 * the declared instance id must match and the DNS key must be among the descriptor's active keys.
 * An unreachable peer is not fatal (44net space may not route from here) — the DNS key becomes the
 * pin, and every future sync verifies against exactly that key or a signed rotation from it.
 */
async function descriptorMatches(
  baseUrl: string,
  expected: { instance: string; publicKey: string },
): Promise<{ checked: boolean; ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`${baseUrl}/.well-known/aprscaching`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!res.ok) return { checked: false, ok: true, detail: `descriptor unreachable (${res.status})` };
    const wk = (await res.json()) as { instance?: string; publicKey?: string | null; publicKeys?: FedPublicKey[] };
    const keys = activeFedKeys(
      wk.publicKeys ?? (wk.publicKey ? [{ x: wk.publicKey }] : []),
      Math.floor(Date.now() / 1000),
    );
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
  const gate = await requireSysop(req, env, { allowIngest: true }); // same gate as the peer-trust surface
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as { callsign?: string; confirm?: boolean };
  let resolved: Resolved44net;
  try {
    resolved = await resolve44net(env, String(body.callsign ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 });
  }
  const url = `http://${resolved.host}`; // amateur IP space: plain http; authenticity is in signatures
  const desc = await descriptorMatches(url, resolved);
  if (desc.checked && !desc.ok)
    return json({ error: `44net binding mismatch: ${desc.detail}`, resolved }, { status: 409 });

  if (!resolved.dnssec && !body.confirm) {
    // no DNSSEC anchor → the operator pins the binding explicitly (trust-on-first-use)
    return json({ requiresConfirm: true, resolved, descriptorChecked: desc.checked });
  }

  const endpoints = JSON.stringify([
    { transport: "44net", address: resolved.host, priority: 10, verifiedVia: "ardc-lot" },
  ]);
  await env.DB.prepare(
    `INSERT INTO fed_peers (url, instance, public_key, trust, added_via, verified_via, endpoints, approved_at)
     VALUES (?,?,?, 'unvetted', '44net', 'ardc-lot', ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       instance     = excluded.instance,
       public_key   = COALESCE(fed_peers.public_key, excluded.public_key),
       verified_via = 'ardc-lot',
       endpoints    = excluded.endpoints,
       trust        = fed_peers.trust`, // an existing tier (incl. 'blocked') is never changed by re-adding
  )
    .bind(url, resolved.instance, resolved.publicKey, endpoints, Math.floor(Date.now() / 1000))
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
