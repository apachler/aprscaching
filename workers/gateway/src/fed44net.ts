// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fed44net.ts — verified peer onboarding by callsign. ARDC's portal reviews a ham's licence before delegating
 * `<call>.ampr.org` (its Level-of-Trust process), so a record under that zone is an externally-verified
 * callsign↔person binding. A peer advertises its federation identity in DNS:
 *
 *   _aprscaching.<call>.ampr.org          TXT  "v=acs1; inst=<instance-id>; key=<b64url raw Ed25519>[; host=<name>][; web=<https origin>]"
 *   _aprscaching.<label>.<call>.ampr.org  TXT  the same, for a further instance under the call
 *
 * Where peers connect:
 * - without `web=`, over 44Net at `host=`, else at the record's own name: `aprscaching.<call>.ampr.org` for
 *   the callsign's record, `<label>.<call>.ampr.org` for a host's record. An instance never runs on the base
 *   name `<call>.ampr.org`: it stays free for the ham's other uses and carries only the lookup records;
 * - with `web=`, over https at that origin, and over 44Net only at a `host=` the record names as well. So an
 *   instance without 44Net publishes `web=` alone, and no A record.
 *
 * `host=` must be a name under `<call>.ampr.org`, never the base itself or another zone; `web=` must be an
 * https origin. Anything else invalidates the whole record. A `host=` stays in the zone the call holder
 * controls; a `web=` origin lies outside it, so its descriptor must list the DNS key and also name the callsign
 * (its service call or operator): copying another instance's public id and key into a record only fails. Both
 * move where the peer is reached, never who it is (the callsign), its key pin or its trust. More than one
 * valid record at a name is ambiguous: the operator is shown the candidates and adds one by its host.
 *
 * A peer is added by callsign (the first record) or by host (the second); a host without a record of its own
 * falls back to the callsign's record when that one sends peers to the host. Every instance added under one
 * callsign records that callsign as its operator, so the corroboration quorum counts them as one voice
 * (corroborate.ts).
 *
 * Onboarding cross-checks the facts: the name exists under ampr.org (ARDC reviewed the licence), the TXT
 * binds an instance id + signing key, the peer's descriptor verifies under that key (at a `web=` origin it
 * must answer and match; over 44Net it is checked when reachable, and the key pin enforces it on every sync),
 * and — when the resolver validates the zone with DNSSEC (the AD flag) — the binding is cryptographically
 * anchored, so the peer is admitted automatically. Without DNSSEC the operator confirms once (a TOFU pin).
 *
 * What this attests is IDENTITY only: the peer enters `unvetted` like any discovered peer, and the
 * operator-set trust tier still governs whether its records count — transport is never trust.
 */
import { nowS } from "./util/time.js";
import { fedFetch } from "./fetchguard.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { requireSysop } from "./admin.js";
import { activeFedKeys, isInstanceId, type FedPublicKey } from "./federation.js";
import { absorbDiscovered, blockedAt } from "./fedpeers.js";
import { resolveTxt, acsFields, amprNames } from "./doh.js";
import { net44Host, parseEndpoints } from "@aprscaching/shared";

const RESOLVE_TIMEOUT_MS = 5000;
const BASE_CALL_RE = /^[A-Za-z0-9]{3,9}$/;

/** A callsign binding read from DNS: who the instance is, and where it is reached. */
export interface AcsBinding {
  instance: string;
  publicKey: string; // b64url raw Ed25519 from the TXT
  host: string | null; // the 44Net name peers contact over plain http, or null without one
  web: string | null; // the https origin peers contact, or null without one
}

interface Resolved44net extends AcsBinding {
  callsign: string; // base call, uppercased
  dnssec: boolean; // the resolver validated the chain (AD flag)
}

const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** `value` lowercased when it is a valid hostname (labels of 1–63 letters, digits and inner hyphens, 253 at most). */
function validHost(value: string): string | null {
  const host = value.toLowerCase();
  return host.length <= 253 && host.split(".").every((l) => HOST_LABEL_RE.test(l)) ? host : null;
}

/** The host a `host=` value names, lowercased, when it is a valid name strictly under `zone`; otherwise null. */
function hostUnder(value: string, zone: string): string | null {
  const host = validHost(value);
  return host?.endsWith(`.${zone}`) ? host : null;
}

/**
 * The https origin a `web=` value names (`https://<host>[:<port>]`, lowercased), or null for anything else:
 * another scheme, credentials, a path, a query or a fragment.
 */
export function webOrigin(value: string): string | null {
  const v = value.trim();
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") return null;
  if (v.replace(/\/$/, "").toLowerCase() !== u.origin) return null; // nothing the URL parser normalised away
  return validHost(u.hostname) ? u.origin : null;
}

/** The base call whose ARDC zone holds `address`, when it is `<call>.ampr.org` or a name under it. */
export function amprCallOf(address: string): string | null {
  const host = validHost(address);
  const m = host ? /(?:^|\.)([a-z0-9]{3,9})\.ampr\.org$/.exec(host) : null;
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * A host an operator typed, lowercased and without one trailing dot, with the base call of the zone it lies
 * in; null for anything but `<call>.ampr.org` or a valid name under it. The base name reads the callsign's
 * record.
 */
export function host44net(value: string): { callsign: string; host: string } | null {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  const callsign = amprCallOf(host);
  return callsign && BASE_CALL_RE.test(callsign) ? { callsign, host } : null;
}

/** The name of this instance's first 44net endpoint in `FED_ENDPOINTS`, lowercased, or null without one. */
export function configured44net(env: Env): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(env.FED_ENDPOINTS ?? "[]");
  } catch {
    return null;
  }
  return (
    parseEndpoints(raw)
      .filter((e) => e.transport === "44net")
      .map((e) => net44Host(e.address))[0] ?? null
  );
}

/**
 * Parse the `v=acs1; inst=…; key=…[; host=…][; web=…]` TXT payload found at `_aprscaching.<recordHost>`, a
 * name in `callsign`'s zone (the zone itself by default). Returns null for anything else, including a `host=`
 * that is not under `<call>.ampr.org` and a `web=` that is not an https origin.
 */
export function parse44netTxt(txt: string, callsign: string, recordHost?: string): AcsBinding | null {
  const fields = acsFields(txt);
  if (!fields) return null;
  const instance = fields.get("inst");
  const publicKey = fields.get("key");
  if (!instance || !publicKey || !/^[A-Za-z0-9_-]{40,50}$/.test(publicKey)) return null; // 32-byte key, b64url
  const { host: zone, instanceHost } = amprNames(callsign);
  const declaredWeb = fields.get("web");
  const web = declaredWeb === undefined ? null : webOrigin(declaredWeb);
  if (declaredWeb !== undefined && !web) return null;
  const declaredHost = fields.get("host");
  let host: string | null;
  if (declaredHost !== undefined) {
    host = hostUnder(declaredHost, zone);
    if (!host) return null;
  } else if (web)
    host = null; // a web= record names a 44Net host only through host=
  else host = recordHost && recordHost !== zone ? recordHost : instanceHost;
  return { instance, publicKey, host, web };
}

/** More than one valid binding at one name: the operator picks one and adds it by its host. */
class AmbiguousBinding extends Error {
  constructor(
    name: string,
    readonly candidates: { instance: string; host: string | null; web: string | null }[],
  ) {
    super(`${name} carries ${candidates.length} aprscaching records: add one of them by its host`);
  }
}

/** No valid binding at a name (missing, or nothing that parses). */
class NoBinding extends Error {}

/** Read the binding at `_aprscaching.<recordHost>` through DNS-over-HTTPS (doh.ts), with the AD flag. */
async function resolveAt(env: Env, callsign: string, recordHost: string): Promise<Resolved44net> {
  const name = `_aprscaching.${recordHost}`;
  const ans = await resolveTxt(env, name);
  if (ans.status !== 0) throw new NoBinding(`no ${name} TXT record (DNS status ${ans.status})`);
  const found = new Map<string, AcsBinding>();
  for (const txt of ans.txts) {
    const parsed = parse44netTxt(txt, callsign, recordHost);
    if (parsed) found.set(`${parsed.instance} ${parsed.publicKey} ${parsed.host} ${parsed.web}`, parsed);
  }
  const bindings = [...found.values()];
  if (bindings.length > 1)
    throw new AmbiguousBinding(
      name,
      bindings.map(({ instance, host, web }) => ({ instance, host, web })),
    );
  if (bindings[0]) return { callsign, ...bindings[0], dnssec: ans.dnssec };
  const verifyOnly = ans.txts.some((t) => acsFields(t)?.has("verify"));
  throw new NoBinding(
    `no valid aprscaching TXT at ${name} (expect "v=acs1; inst=…; key=…", with any host= under ${amprNames(callsign).host} and any web= an https origin)` +
      (verifyOnly ? `; a verify= record belongs at ${amprNames(callsign).verify}` : ""),
  );
}

/** Resolve a callsign's federation TXT at `_aprscaching.<call>.ampr.org`. */
export async function resolve44net(env: Env, callsign: string): Promise<Resolved44net> {
  const cs = callsign.trim().toUpperCase();
  if (!BASE_CALL_RE.test(cs)) throw new Error("a base callsign is required (letters/digits, no SSID)");
  return resolveAt(env, cs, amprNames(cs).host);
}

/**
 * Resolve one host's federation TXT at `_aprscaching.<host>`, for a host in its callsign's ampr.org zone. A host
 * without a binding of its own takes the callsign's, when that one sends peers to this host.
 */
export async function resolve44netHost(env: Env, value: string): Promise<Resolved44net> {
  const named = host44net(value);
  if (!named) throw new Error("the host must be <call>.ampr.org or a name under it");
  const zone = amprNames(named.callsign).host;
  if (named.host === zone) return resolveAt(env, named.callsign, zone);
  try {
    return await resolveAt(env, named.callsign, named.host);
  } catch (e) {
    if (!(e instanceof NoBinding)) throw e;
    const byCall = await resolveAt(env, named.callsign, zone).catch(() => null);
    if (byCall?.host === named.host) return byCall;
    throw e;
  }
}

/**
 * Cross-check the DNS-advertised binding against the peer's live descriptor at `baseUrl`: the declared
 * instance id must match and the DNS key must be among the descriptor's active keys. `checked: false` when
 * the descriptor did not answer.
 */
async function descriptorMatches(
  env: Env,
  baseUrl: string,
  expected: { instance: string; publicKey: string },
  callsign?: string,
): Promise<{ checked: boolean; ok: boolean; detail?: string }> {
  try {
    const res = await fedFetch(env, `${baseUrl}/.well-known/aprscaching`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!res.ok) return { checked: false, ok: true, detail: `descriptor unreachable (${res.status})` };
    const wk = (await res.json()) as {
      instance?: string;
      publicKeys?: FedPublicKey[];
      aprsCall?: unknown;
      operator?: unknown;
    };
    // An instance id and a public key are public, so a record outside the callsign's zone could copy another
    // instance's: its descriptor must name the callsign too (its service call or FED_OPERATOR), the origin's own
    // word that it runs under this call.
    if (callsign) {
      const calls = [wk.aprsCall, wk.operator]
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim().split("-")[0]!.toUpperCase());
      if (!calls.includes(callsign))
        return {
          checked: true,
          ok: false,
          detail: `the descriptor at ${baseUrl} names no call of ${callsign} (its aprsCall or operator)`,
        };
    }
    const keys = activeFedKeys(Array.isArray(wk.publicKeys) ? wk.publicKeys : [], nowS());
    if (wk.instance !== expected.instance)
      return {
        checked: true,
        ok: false,
        detail: `descriptor at ${baseUrl} names instance '${wk.instance}', DNS 'inst=${expected.instance}'`,
      };
    if (!keys.includes(expected.publicKey))
      return {
        checked: true,
        ok: false,
        detail: `the DNS-advertised key is not among the active keys of the descriptor at ${baseUrl}`,
      };
    return { checked: true, ok: true };
  } catch {
    return { checked: false, ok: true, detail: "descriptor unreachable" };
  }
}

/**
 * POST /federation/peers/44net — sysop-only. Body { callsign | host, confirm? }. Resolves the callsign's or
 * the host's federation TXT (409 with `candidates` when it is ambiguous) and cross-checks the descriptor: at a
 * `web=` origin it must answer and match, over 44Net a reachable one must match. Admits the peer as
 * `unvetted` when the binding is DNSSEC-validated OR the operator confirms; otherwise returns the resolved
 * binding for a one-click confirm. A blocked instance is refused under any address.
 */
export async function handleFed44netAdd(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true }); // same gate as the peer-trust surface
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as { callsign?: string; host?: string; confirm?: boolean };
  const host = String(body.host ?? "").trim();
  if (host && String(body.callsign ?? "").trim())
    return json({ error: "give a callsign or a host, not both" }, { status: 400 });
  let resolved: Resolved44net;
  try {
    resolved = host ? await resolve44netHost(env, host) : await resolve44net(env, String(body.callsign ?? ""));
  } catch (e) {
    if (e instanceof AmbiguousBinding) return json({ error: e.message, candidates: e.candidates }, { status: 409 });
    return json({ error: (e as Error).message }, { status: 400 });
  }

  // An https origin must answer with a matching descriptor: it is the one path the DNS key is checked over
  // before the pin. Over 44Net (plain http on an amateur-space name; authenticity is in signatures) the
  // peer may not route from here, so an unreachable descriptor leaves the DNS key as the pin.
  let descriptorChecked = false;
  if (resolved.web) {
    const d = await descriptorMatches(env, resolved.web, resolved, resolved.callsign);
    if (!d.checked)
      return json(
        { error: `${resolved.web} did not answer with its descriptor (${d.detail}) — try again later`, resolved },
        { status: 502 },
      );
    if (!d.ok) return json({ error: `callsign binding mismatch: ${d.detail}`, resolved }, { status: 409 });
    descriptorChecked = true;
  }
  if (resolved.host) {
    const d = await descriptorMatches(env, `http://${resolved.host}`, resolved);
    if (d.checked && !d.ok) return json({ error: `callsign binding mismatch: ${d.detail}`, resolved }, { status: 409 });
    descriptorChecked ||= d.checked;
  }

  if (!resolved.dnssec && !body.confirm) {
    // no DNSSEC anchor → the operator pins the binding explicitly (trust-on-first-use)
    return json({ requiresConfirm: true, resolved, descriptorChecked });
  }

  // the instance id binds to one live peer row: never rename a known row, never share an id
  if (!isInstanceId(resolved.instance))
    return json({ error: "the DNS binding names an invalid instance id", resolved }, { status: 409 });
  const url = resolved.web ?? `http://${resolved.host}`;
  // a block covers the instance under any address, this one included
  const blocked = await blockedAt(env, resolved.instance);
  if (blocked)
    return json(
      {
        error: `${resolved.instance} is blocked here (at ${blocked}): remove that peer first to add it again`,
        resolved,
      },
      { status: 409 },
    );
  // a row only discovery brought gives way to the verified binding
  await absorbDiscovered(env, resolved.instance);
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

  // With both endpoints, an instance on 44Net itself reaches the peer over 44Net first; any other over https.
  const over44 = configured44net(env) !== null;
  const endpoints = JSON.stringify([
    ...(resolved.web
      ? [
          {
            transport: "https",
            address: resolved.web,
            priority: over44 && resolved.host ? 20 : 10,
            verifiedVia: "ardc-lot",
          },
        ]
      : []),
    ...(resolved.host
      ? [
          {
            transport: "44net",
            address: resolved.host,
            priority: over44 || !resolved.web ? 10 : 20,
            verifiedVia: "ardc-lot",
          },
        ]
      : []),
  ]);
  await env.DB.prepare(
    // unvetted, so not approved: approved_at waits for the operator's trust decision
    `INSERT INTO fed_peers (url, instance, public_key, trust, added_via, verified_via, endpoints, endpoints_source, operator_call)
     VALUES (?,?,?, 'unvetted', '44net', 'ardc-lot', ?, 'dns', ?)
     ON CONFLICT(url) DO UPDATE SET
       instance         = COALESCE(fed_peers.instance, excluded.instance),
       public_key       = COALESCE(fed_peers.public_key, excluded.public_key),
       verified_via     = 'ardc-lot',
       endpoints        = excluded.endpoints,
       endpoints_source = 'dns',
       operator_call    = excluded.operator_call,
       trust            = fed_peers.trust`, // an existing tier is never changed by re-adding
  )
    .bind(url, resolved.instance, resolved.publicKey, endpoints, resolved.callsign)
    .run();
  return json(
    {
      ok: true,
      admitted: resolved.dnssec ? "dnssec" : "operator-confirmed",
      peer: { url, instance: resolved.instance, callsign: resolved.callsign, trust: "unvetted" },
      descriptorChecked,
    },
    { status: 201 },
  );
}
