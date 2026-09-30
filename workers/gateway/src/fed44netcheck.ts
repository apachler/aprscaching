// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fed44netcheck.ts — the 44Net self-check: what another instance finds when it adds this one by callsign
 * (fed44net.ts), checked from here, on demand and read-only.
 *
 * The callsign is read from this instance's own 44net endpoint (`FED_ENDPOINTS`): the address is
 * `<call>.ampr.org` or a name under it, and the label before `ampr.org` is the call. INSTANCE cannot name it —
 * it is usually the instance's https domain. The EFFECTIVE host is where peers contact this instance: the
 * `host=` of the published TXT, or `<call>.ampr.org` when the TXT has none. With no usable TXT the check uses
 * the endpoint address, the host the TXT to publish names.
 *
 * Lines, each pass / warn / fail / info with a one-sentence fix on the non-passing ones:
 * - the endpoint is a name under `<call>.ampr.org`;
 * - the effective host has an A record, inside 44.0.0.0/8;
 * - `_aprscaching.<call>.ampr.org` carries the federation binding with this instance's id and current key
 *   (a `verify=` record at the same name is a callsign verification, not the binding);
 * - the descriptor this instance publishes lists the effective host as its 44net endpoint;
 * - whether the TXT answer was DNSSEC-validated, and any AAAA record, as information.
 *
 * It asks DNS through doh.ts and builds its own descriptor in-process: no reachability probe, no fetch of
 * itself, and nothing written — no peer rows and no trust state.
 */
import { applyDerivedDefaults, type Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { activeFedKeys, handleWellKnown, type FedPublicKey } from "./federation.js";
import { hostInZone, parse44netTxt } from "./fed44net.js";
import { acsFields, amprNames, resolveRecord, type DnsAnswer, type RecordType } from "./doh.js";
import { nowS } from "./util/time.js";
import { parseEndpoints } from "@aprscaching/shared";

export interface CheckLine {
  id: "endpoint" | "a" | "txt" | "descriptor" | "dnssec" | "aaaa";
  status: "pass" | "warn" | "fail" | "info";
  label: string;
  detail: string;
  /** One sentence saying what to change; set on every warn and fail. */
  fix?: string;
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

const PORTAL = "in the 44Net Portal (changes there publish within about an hour)";
const DOH_FIX = "Check that DOH_URL reaches a DNS-over-HTTPS resolver, then run the check again.";
const IN_44_NET = /^44\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** The base call whose ARDC zone holds `address`, when it is `<call>.ampr.org` or a name under it. */
export function amprCallOf(address: string): string | null {
  const m = /(?:^|\.)([a-z0-9]{3,9})\.ampr\.org$/.exec(address.toLowerCase());
  return m && hostInZone(address, amprNames(m[1]!).host) ? m[1]!.toUpperCase() : null;
}

/** The address of this instance's first 44net endpoint in `FED_ENDPOINTS`, or null without one. */
export function configured44net(env: Env): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(env.FED_ENDPOINTS ?? "[]");
  } catch {
    return null;
  }
  return parseEndpoints(raw).find((e) => e.transport === "44net")?.address ?? null;
}

async function lookup(dns: DnsLookup, name: string, type: RecordType): Promise<DnsAnswer | Error> {
  try {
    return await dns(name, type);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * Run the check against this instance's descriptor with `dns` answering. Null when the descriptor lists no
 * 44net endpoint: the check does not apply.
 */
export async function check44net(
  desc: OwnDescriptor,
  dns: DnsLookup,
): Promise<{ callsign: string | null; host: string; lines: CheckLine[] } | null> {
  const listed = (desc.addresses ?? []).filter((a) => a.transport === "44net").map((a) => a.address.toLowerCase());
  const endpoint = listed[0];
  if (!endpoint) return null;
  const callsign = amprCallOf(endpoint);
  if (!callsign)
    return {
      callsign: null,
      host: endpoint,
      lines: [
        {
          id: "endpoint",
          status: "fail",
          label: "44net endpoint",
          detail: `${endpoint} is not a name under <call>.ampr.org, where peers look up a callsign's binding`,
          fix: "Set the 44net address in FED_ENDPOINTS to <call>.ampr.org or a name under it.",
        },
      ],
    };

  const { host: zone, name } = amprNames(callsign);
  const lines: CheckLine[] = [
    { id: "endpoint", status: "pass", label: "44net endpoint", detail: `${endpoint} — callsign ${callsign}` },
  ];

  // ---- the TXT binding; its host= decides which name the other checks look at
  const expected =
    desc.publicKey &&
    `v=acs1; inst=${desc.instance}; key=${desc.publicKey}${endpoint === zone ? "" : `; host=${endpoint}`}`;
  const publishFix = expected
    ? `Publish TXT ${name} "${expected}" ${PORTAL}.`
    : "Set FED_PRIVATE_KEY (node tools/fedkey/genkey.mjs) and restart, then run the check again for the TXT to publish.";
  const txtAns = await lookup(dns, name, "TXT");
  const txts = txtAns instanceof Error || txtAns.status !== 0 ? [] : txtAns.data;
  const parsed = txts.map((t) => parse44netTxt(t, callsign)).filter((p) => p !== null);
  const binding =
    parsed.find((p) => p.instance === desc.instance && p.publicKey === desc.publicKey) ?? parsed[0] ?? null;
  const host = binding?.host ?? endpoint;
  let txt: CheckLine;
  if (txtAns instanceof Error) {
    txt = {
      id: "txt",
      status: "warn",
      label: "Federation TXT",
      detail: `DNS lookup failed (${txtAns.message})`,
      fix: DOH_FIX,
    };
  } else if (!desc.publicKey) {
    txt = {
      id: "txt",
      status: "fail",
      label: "Federation TXT",
      detail: "this instance has no federation signing key",
      fix: publishFix,
    };
  } else if (!binding) {
    const verifyOnly = txts.some((t) => acsFields(t)?.has("verify"));
    const detail = !txts.length
      ? `no TXT record at ${name}`
      : `no record at ${name} parses as "v=acs1; inst=…; key=…" with any host= under ${zone}` +
        (verifyOnly ? " — a verify= record proves callsign control and does not carry the binding" : "");
    txt = { id: "txt", status: "fail", label: "Federation TXT", detail, fix: publishFix };
  } else if (binding.instance !== desc.instance) {
    txt = {
      id: "txt",
      status: "fail",
      label: "Federation TXT",
      detail: `inst=${binding.instance}, but this instance is ${desc.instance}`,
      fix: publishFix,
    };
  } else if (binding.publicKey !== desc.publicKey) {
    const active = activeFedKeys(desc.publicKeys ?? [], nowS()).includes(binding.publicKey);
    txt = {
      id: "txt",
      status: active ? "warn" : "fail",
      label: "Federation TXT",
      detail: active
        ? "key= is an older key this instance still lists; peers adding you now pin that key"
        : "key= is not this instance's federation key; peers refuse the binding",
      fix: publishFix,
    };
  } else {
    txt = {
      id: "txt",
      status: "pass",
      label: "Federation TXT",
      detail: `${name} binds ${desc.instance} and its current key`,
    };
  }

  // ---- the A record of the effective host
  const aAns = await lookup(dns, host, "A");
  let a: CheckLine;
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
      fix: `Add the record A ${host} pointing at your 44Net address (44.x.x.x) ${PORTAL}.`,
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

  // ---- the descriptor this instance publishes, built in-process
  const descriptor: CheckLine = listed.includes(host)
    ? { id: "descriptor", status: "pass", label: "Descriptor endpoint", detail: `the descriptor lists 44net ${host}` }
    : {
        id: "descriptor",
        status: "fail",
        label: "Descriptor endpoint",
        detail: `peers contact ${host} (the TXT's host), but the descriptor lists 44net ${listed.join(", ")}`,
        fix:
          endpoint === zone
            ? `Drop host= from the TXT, or set the 44net address in FED_ENDPOINTS to ${host}.`
            : `Put host=${endpoint} in the TXT, or set the 44net address in FED_ENDPOINTS to ${host}.`,
      };

  lines.push(a, txt, descriptor);

  // ---- information
  if (!(txtAns instanceof Error) && txtAns.status === 0 && txts.length)
    lines.push({
      id: "dnssec",
      status: "info",
      label: "DNSSEC",
      detail: txtAns.dnssec
        ? "the TXT answer is DNSSEC-validated: peers admit this instance automatically"
        : "the TXT answer is not DNSSEC-validated: a peer's operator confirms your key once when adding you",
    });
  const aaaa = await lookup(dns, host, "AAAA");
  if (!(aaaa instanceof Error) && aaaa.status === 0 && aaaa.data.length)
    lines.push({
      id: "aaaa",
      status: "info",
      label: "IPv6 (AAAA)",
      detail: `${host} has AAAA ${aaaa.data.join(", ")}: federation onboarding uses the IPv4 A record; an AAAA record is not used`,
    });
  return { callsign, host, lines };
}

/**
 * GET /api/admin/setup/44net — sysop-only. Runs the check against the descriptor this instance serves,
 * built in-process, with DNS through `DOH_URL`. `{ applicable: false }` without a 44net endpoint.
 */
export async function handleFed44netCheck(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowOperatorSecret: true });
  if (gate) return gate;
  applyDerivedDefaults(env);
  const desc: OwnDescriptor = await (await handleWellKnown(req, env)).json();
  const result = await check44net(desc, (name, type) => resolveRecord(env, name, type));
  return json(result ? { applicable: true, ...result } : { applicable: false });
}
