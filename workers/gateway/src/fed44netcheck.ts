// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fed44netcheck.ts — this instance's callsign identity: the DNS records that let another instance add it by
 * callsign (fed44net.ts), and a self-check of what that instance finds, on demand and read-only.
 *
 * The callsign is the zone of this instance's 44net endpoint (`FED_ENDPOINTS`), else the first of
 * `ADMIN_CALLSIGNS`. The records follow from the instance's `INSTANCE`, its federation key, that callsign,
 * the 44net endpoint and `APP_URL`, and name each record as the 44Net Portal takes it (the part left of
 * `<call>.ampr.org`):
 *
 * - on 44Net at the default name `aprscaching.<call>.ampr.org`: A `aprscaching` → the 44.x address, and TXT
 *   `_aprscaching` = `v=acs1; inst=…; key=…`;
 * - on 44Net at another name `<label>.<call>.ampr.org`: A `<label>` and TXT `_aprscaching.<label>`;
 * - on 44Net with an https `APP_URL` as well: the same TXT may carry `; host=<name>; web=<origin>`, so peers
 *   adding by callsign learn both endpoints (offered as the alternative value);
 * - without 44Net: TXT `_aprscaching` = `v=acs1; inst=…; key=…; web=<APP_URL origin>`, and no A record.
 *
 * The check's lines, each pass / warn / fail / info, with a one-sentence fix on the non-passing ones:
 * - the 44net endpoint is a name under `<call>.ampr.org`, never the base name itself;
 * - the 44Net host peers contact has an A record, inside 44.0.0.0/8;
 * - the identity record carries this instance's id and current key (a `verify=` record is a callsign
 *   verification and belongs at `_aprscaching-verify.<call>.ampr.org`); for an instance under its own
 *   name, whether the callsign's record sends peers to it with another binding;
 * - the record sends peers where this instance is: its 44net endpoint and its https origin;
 * - whether the TXT answer was DNSSEC-validated, and any AAAA record, as information.
 * An instance without 44Net that has published nothing gets one information line: publishing is optional.
 *
 * It asks DNS through doh.ts and builds its own descriptor in-process: no reachability probe, no fetch of
 * itself, and nothing written — no peer rows and no trust state.
 */
import { applyDerivedDefaults, type Env } from "./env.js";
import { json } from "./app.js";
import { adminCalls, requireSysop } from "./admin.js";
import { activeFedKeys, handleWellKnown, type FedPublicKey } from "./federation.js";
import { amprCallOf, parse44netTxt, webOrigin, type AcsBinding } from "./fed44net.js";
import { acsFields, amprNames, resolveRecord, type DnsAnswer, type RecordType } from "./doh.js";
import { nowS } from "./util/time.js";

export interface CheckLine {
  id: "endpoint" | "a" | "txt" | "callsign" | "target" | "dnssec" | "aaaa";
  status: "pass" | "warn" | "fail" | "info";
  label: string;
  detail: string;
  /** One sentence saying what to change; set on every warn and fail. */
  fix?: string;
}

/** One DNS record to publish, as the 44Net Portal takes it. */
export interface PortalRecord {
  /** The full DNS name. */
  name: string;
  /** The name as entered in the Portal: the part left of `<call>.ampr.org`. */
  portal: string;
  type: "A" | "TXT";
  value: string;
  /** The value is a placeholder the sysop fills in (the 44.x address the gateway cannot see). */
  placeholder: boolean;
  /** What the record does, in one sentence. */
  purpose: string;
}

/** The records this instance publishes for its callsign identity, or why it publishes none. */
interface IdentityPlan {
  callsign: string | null;
  /** The 44Net name peers contact, or null without 44Net. */
  host: string | null;
  /** The https origin peers contact, or null without one. */
  web: string | null;
  records: PortalRecord[];
  /** The identity TXT with both endpoints, for an instance on 44Net with an https origin too. */
  alternative: PortalRecord | null;
  /** Set when there is nothing to publish yet, saying what is missing. */
  reason?: string;
}

/** A DNS lookup: the answer, or a throw when the resolver itself fails. */
export type DnsLookup = (name: string, type: RecordType) => Promise<DnsAnswer>;

/** The parts of this instance's descriptor (`/.well-known/aprscaching`) the check reads. */
interface OwnDescriptor {
  instance: string;
  publicKey: string | null;
  publicKeys?: FedPublicKey[];
  addresses?: { transport: string; address: string }[];
}

/** What the plan and the check start from. */
export interface IdentityContext {
  desc: OwnDescriptor;
  /** The operator's base call, when no 44net endpoint names one (the first of `ADMIN_CALLSIGNS`). */
  operatorCall?: string | null;
  /** The https origin of `APP_URL`, or null. */
  web: string | null;
}

const PORTAL = "in the 44Net Portal (changes there publish within about an hour)";
const DOH_FIX = "Check that DOH_URL reaches a DNS-over-HTTPS resolver, then run the check again.";
const KEY_FIX = "Set FED_PRIVATE_KEY (node tools/fedkey/genkey.mjs) and restart, then run the check again.";
const IN_44_NET = /^44\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** The 44net endpoint the descriptor lists first, lowercased. */
const endpointOf = (desc: OwnDescriptor) =>
  (desc.addresses ?? []).find((a) => a.transport === "44net")?.address.toLowerCase() ?? null;

/** The base call this instance's identity lives under: its 44net endpoint's zone, else the operator's call. */
function callsignOf(ctx: IdentityContext): string | null {
  const endpoint = endpointOf(ctx.desc);
  const fromEndpoint = endpoint ? amprCallOf(endpoint) : null;
  const base = (fromEndpoint ?? ctx.operatorCall ?? "").split("-")[0]!.trim().toUpperCase();
  return /^[A-Z0-9]{3,9}$/.test(base) ? base : null;
}

/** The records to publish, computed from the descriptor, the callsign, the 44net endpoint and the https origin. */
export function identityPlan(ctx: IdentityContext): IdentityPlan {
  const callsign = callsignOf(ctx);
  const endpoint = endpointOf(ctx.desc);
  const empty = { callsign, host: null, web: ctx.web, records: [], alternative: null };
  if (!callsign)
    return { ...empty, reason: "No callsign: set ADMIN_CALLSIGNS, or a 44net endpoint under <call>.ampr.org." };
  if (!ctx.desc.publicKey) return { ...empty, reason: `No federation signing key. ${KEY_FIX}` };
  const { host: zone, name: zoneName, instanceHost } = amprNames(callsign);
  const portal = (name: string) => name.slice(0, -(zone.length + 1));
  // an endpoint that is not an instance name under the call (the base name, another zone) gets the default
  const host = endpoint ? (endpoint.endsWith(`.${zone}`) ? endpoint : instanceHost) : null;
  const base = `v=acs1; inst=${ctx.desc.instance}; key=${ctx.desc.publicKey}`;
  if (host) {
    const txtName = host === instanceHost ? zoneName : `_aprscaching.${host}`;
    const txt = (value: string, purpose: string): PortalRecord => ({
      name: txtName,
      portal: portal(txtName),
      type: "TXT",
      value,
      placeholder: false,
      purpose,
    });
    return {
      callsign,
      host,
      web: ctx.web,
      records: [
        {
          name: host,
          portal: portal(host),
          type: "A",
          value: "<your 44.x address>",
          placeholder: true,
          purpose: "The 44Net address peers connect to.",
        },
        txt(
          base,
          host === instanceHost
            ? `Your federation identity: peers add you by callsign, ${callsign}.`
            : `This instance's federation identity: peers add it by its host, ${host}.`,
        ),
      ],
      alternative: ctx.web
        ? txt(
            `${base}; host=${host}; web=${ctx.web}`,
            "The same identity naming your https address too, for peers that cannot reach 44Net.",
          )
        : null,
    };
  }
  if (!ctx.web)
    return {
      ...empty,
      reason: "No 44net endpoint and no https APP_URL: peers adding you by callsign would have nowhere to connect.",
    };
  return {
    callsign,
    host: null,
    web: ctx.web,
    records: [
      {
        name: zoneName,
        portal: portal(zoneName),
        type: "TXT",
        value: `${base}; web=${ctx.web}`,
        placeholder: false,
        purpose: `Your federation identity without 44Net: peers add you by callsign, ${callsign}, and connect to ${ctx.web}.`,
      },
    ],
    alternative: null,
  };
}

async function lookup(dns: DnsLookup, name: string, type: RecordType): Promise<DnsAnswer | Error> {
  try {
    return await dns(name, type);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

const describeTarget = (b: AcsBinding) =>
  [b.host && `44Net ${b.host}`, b.web && `https ${b.web}`].filter(Boolean).join(" and ");

/**
 * Run the check with `dns` answering. Null when it does not apply: no callsign, or neither a 44net endpoint
 * nor an https origin.
 */
export async function check44net(
  ctx: IdentityContext,
  dns: DnsLookup,
): Promise<(IdentityPlan & { lines: CheckLine[] }) | null> {
  const plan = identityPlan(ctx);
  const { desc } = ctx;
  const endpoint = endpointOf(desc);
  const callsign = plan.callsign;
  if (!callsign || (!endpoint && !ctx.web)) return null;
  const { host: zone, name: zoneName, verify, instanceHost } = amprNames(callsign);
  const lines: CheckLine[] = [];

  // ---- the 44net endpoint: a name under the call, never the base name
  if (endpoint) {
    if (amprCallOf(endpoint) !== callsign || !endpoint.endsWith(`.${zone}`)) {
      lines.push({
        id: "endpoint",
        status: "fail",
        label: "44net endpoint",
        detail:
          endpoint === zone
            ? `${endpoint} is the base name: it stays free for your other uses, and an instance runs at a name under it`
            : `${endpoint} is not a name under <call>.ampr.org, where peers look up a callsign's binding`,
        fix: `Set the 44net address in FED_ENDPOINTS to ${instanceHost} (deploy/aprscaching net44 setup --name ${instanceHost}).`,
      });
      return { ...plan, lines };
    }
    lines.push({
      id: "endpoint",
      status: "pass",
      label: "44net endpoint",
      detail: `${endpoint} — callsign ${callsign}`,
    });
  } else {
    lines.push({
      id: "endpoint",
      status: "info",
      label: "44net endpoint",
      detail: `none: peers adding ${callsign} reach this instance over https, at ${ctx.web}`,
    });
  }

  const txtRecord = plan.records.find((r) => r.type === "TXT");
  if (!txtRecord) {
    lines.push({
      id: "txt",
      status: "fail",
      label: "Identity TXT",
      detail: plan.reason ?? "nothing to publish",
      fix: KEY_FIX,
    });
    return { ...plan, lines };
  }

  // ---- the identity TXT: the record at its expected name, and the callsign's for an instance under its own
  const recordName = txtRecord.name;
  const publishFix = `Publish TXT ${recordName} "${txtRecord.value}" ${PORTAL}; the Portal name is ${txtRecord.portal}.`;
  const bindingsIn = (ans: DnsAnswer | Error | null, recordHost: string) =>
    (!ans || ans instanceof Error || ans.status !== 0 ? [] : ans.data)
      .map((t) => parse44netTxt(t, callsign, recordHost))
      .filter((p) => p !== null);
  const pick = (ps: AcsBinding[]) =>
    ps.find((p) => p.instance === desc.instance && p.publicKey === desc.publicKey) ?? ps[0] ?? null;
  const ownRecord = recordName !== zoneName;
  const ownHost = recordName.slice("_aprscaching.".length);
  const hostAns = ownRecord ? await lookup(dns, recordName, "TXT") : null;
  const zoneAns = await lookup(dns, zoneName, "TXT");
  const hostBinding = ownRecord ? pick(bindingsIn(hostAns, ownHost)) : null;
  const zoneBindings = bindingsIn(zoneAns, zone);
  const zoneBinding = pick(zoneBindings);
  // without a record of its own, a host takes the callsign's record when that one sends peers to it
  const binding = ownRecord
    ? (hostBinding ?? pick(zoneBindings.filter((b) => b.host === ownHost)) ?? null)
    : zoneBinding;
  const bindingName = hostBinding ? recordName : zoneName;
  const txtAns = hostBinding ? hostAns! : zoneAns;
  const txts = [hostAns, zoneAns].flatMap((a) => (!a || a instanceof Error || a.status !== 0 ? [] : a.data));
  const failed = [hostAns, zoneAns].find((x): x is Error => x instanceof Error);
  let txt: CheckLine;
  if (!binding && failed) {
    txt = {
      id: "txt",
      status: "warn",
      label: "Identity TXT",
      detail: `DNS lookup failed (${failed.message})`,
      fix: DOH_FIX,
    };
  } else if (!binding && !endpoint && !txts.length) {
    txt = {
      id: "txt",
      status: "info",
      label: "Identity TXT",
      detail: `not published: peers cannot add this instance by callsign, ${callsign}. Publishing it is optional`,
      fix: publishFix,
    };
  } else if (!binding) {
    const verifyOnly = txts.some((t) => acsFields(t)?.has("verify"));
    const names = ownRecord ? `${recordName} or ${zoneName}` : zoneName;
    const detail = !txts.length
      ? `no TXT record at ${names}`
      : `no record at ${names} parses as "v=acs1; inst=…; key=…" naming this instance's place` +
        (verifyOnly ? ` — a verify= record proves callsign control and belongs at ${verify}` : "");
    txt = { id: "txt", status: "fail", label: "Identity TXT", detail, fix: publishFix };
  } else if (binding.instance !== desc.instance) {
    txt = {
      id: "txt",
      status: "fail",
      label: "Identity TXT",
      detail: `inst=${binding.instance}, but this instance is ${desc.instance}`,
      fix: publishFix,
    };
  } else if (binding.publicKey !== desc.publicKey) {
    const active = activeFedKeys(desc.publicKeys ?? [], nowS()).includes(binding.publicKey);
    txt = {
      id: "txt",
      status: active ? "warn" : "fail",
      label: "Identity TXT",
      detail: active
        ? "key= is an older key this instance still lists; peers adding you now pin that key"
        : "key= is not this instance's federation key; peers refuse the binding",
      fix: publishFix,
    };
  } else {
    txt = {
      id: "txt",
      status: "pass",
      label: "Identity TXT",
      detail: `${bindingName} binds ${desc.instance} and its current key`,
    };
  }

  // ---- both records: the callsign's must not send peers to this host with another binding
  let byCallsign: CheckLine | null = null;
  if (hostBinding && zoneBinding) {
    const same = zoneBinding.instance === hostBinding.instance && zoneBinding.publicKey === hostBinding.publicKey;
    if (zoneBinding.host === ownHost && !same)
      byCallsign = {
        id: "callsign",
        status: "warn",
        label: "Callsign record",
        detail: `${zoneName} sends peers to ${ownHost} as ${zoneBinding.instance}, but ${recordName} binds ${hostBinding.instance} there with ${zoneBinding.publicKey === hostBinding.publicKey ? "the same" : "another"} key`,
        fix: `Make ${zoneName} name the same instance and key as ${recordName}, or point it at another host.`,
      };
    else if (zoneBinding.host !== ownHost)
      byCallsign = {
        id: "callsign",
        status: "info",
        label: "Callsign record",
        detail: `peers adding ${callsign} by callsign get ${zoneBinding.instance} at ${describeTarget(zoneBinding)}; they add this instance by its host, ${ownHost}`,
      };
  }

  // ---- where the record sends peers, against where this instance is
  let target: CheckLine | null = null;
  if (binding && txt.status !== "fail") {
    const listed44 = (desc.addresses ?? []).filter((a) => a.transport === "44net").map((a) => a.address.toLowerCase());
    const webs = new Set(
      [
        ctx.web,
        ...(desc.addresses ?? []).filter((a) => a.transport === "https").map((a) => webOrigin(a.address)),
      ].filter((w): w is string => !!w),
    );
    const problems: { detail: string; status: "warn" | "fail" }[] = [];
    if (binding.host && !listed44.includes(binding.host))
      problems.push({
        status: "fail",
        detail: listed44.length
          ? `peers contact ${binding.host}, but the descriptor lists 44net ${listed44.join(", ")}`
          : `the record sends peers to 44Net at ${binding.host}, but this instance has no 44net endpoint`,
      });
    if (binding.web && !webs.has(binding.web))
      problems.push({
        status: "fail",
        detail: `web=${binding.web}, but this instance is at ${ctx.web ?? "no https address"}`,
      });
    if (!binding.host && endpoint)
      problems.push({
        status: "warn",
        detail: `the record names no 44Net host, so peers reach ${endpoint} only by its own host`,
      });
    target = problems.length
      ? {
          id: "target",
          status: problems.some((p) => p.status === "fail") ? "fail" : "warn",
          label: "Where peers connect",
          detail: problems.map((p) => p.detail).join("; "),
          fix: publishFix,
        }
      : { id: "target", status: "pass", label: "Where peers connect", detail: describeTarget(binding) };
  }

  // ---- the A record of the 44Net host peers contact
  const host = binding?.host ?? plan.host;
  let a: CheckLine | null = null;
  if (host) {
    const aAns = await lookup(dns, host, "A");
    if (aAns instanceof Error) {
      a = {
        id: "a",
        status: "warn",
        label: "Address record",
        detail: `DNS lookup failed (${aAns.message})`,
        fix: DOH_FIX,
      };
    } else if (aAns.status !== 0 || !aAns.data.length) {
      a = {
        id: "a",
        status: "fail",
        label: "Address record",
        detail: `${host} has no A record, so peers cannot reach it`,
        fix: `Add the record A ${host} pointing at your 44Net address (44.x.x.x) ${PORTAL}; the Portal name is ${host.slice(0, -(zone.length + 1))}.`,
      };
    } else if (!aAns.data.every((ip) => IN_44_NET.test(ip))) {
      a = {
        id: "a",
        status: "warn",
        label: "Address record",
        detail: `${host} → ${aAns.data.join(", ")}, outside 44.0.0.0/8`,
        fix: `Point ${host} at your 44Net Connect address (44.x.x.x) so 44Net peers reach you over 44Net.`,
      };
    } else {
      a = { id: "a", status: "pass", label: "Address record", detail: `${host} → ${aAns.data.join(", ")}` };
    }
  }

  if (a) lines.push(a);
  lines.push(txt);
  if (byCallsign) lines.push(byCallsign);
  if (target) lines.push(target);

  // ---- information
  if (binding && !(txtAns instanceof Error) && txtAns.status === 0)
    lines.push({
      id: "dnssec",
      status: "info",
      label: "DNSSEC",
      detail: txtAns.dnssec
        ? "the TXT answer is DNSSEC-validated: peers admit this instance automatically"
        : "the TXT answer is not DNSSEC-validated: a peer's operator confirms your key once when adding you",
    });
  if (host) {
    const aaaa = await lookup(dns, host, "AAAA");
    if (!(aaaa instanceof Error) && aaaa.status === 0 && aaaa.data.length)
      lines.push({
        id: "aaaa",
        status: "info",
        label: "IPv6 (AAAA)",
        detail: `${host} has AAAA ${aaaa.data.join(", ")}: federation onboarding uses the IPv4 A record; an AAAA record is not used`,
      });
  }
  return { ...plan, lines };
}

/** This instance's identity context: its own descriptor (built in-process), the operator's call and APP_URL. */
async function contextOf(req: Request, env: Env): Promise<IdentityContext> {
  applyDerivedDefaults(env);
  const desc: OwnDescriptor = await (await handleWellKnown(req, env)).json();
  let web: string | null;
  try {
    web = env.APP_URL ? webOrigin(new URL(env.APP_URL).origin) : null;
  } catch {
    web = null; // an APP_URL that does not parse names no origin
  }
  return { desc, operatorCall: [...adminCalls(env)][0] ?? null, web };
}

/**
 * GET /api/admin/federation/identity[?check=1] — sysop-only. The records this instance publishes for its
 * callsign identity, each as the 44Net Portal takes it; with `check=1` also the self-check's lines, with DNS
 * through `DOH_URL`. `{ applicable: false, reason }` when there is no callsign, or nowhere peers could connect.
 */
export async function handleIdentity(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  const ctx = await contextOf(req, env);
  const plan = identityPlan(ctx);
  if (!new URL(req.url).searchParams.has("check")) return json({ applicable: !plan.reason, ...plan });
  const result = await check44net(ctx, (name, type) => resolveRecord(env, name, type));
  return json(result ? { applicable: true, ...result } : { applicable: false, ...plan });
}
