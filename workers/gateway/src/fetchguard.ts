// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fetchguard.ts — keep federation fetches off private networks.
 *
 * Federation fetches URLs that come from other parties: peer-advertised addresses, registry and DNS
 * records, 44net names. On a self-hosted gateway such a URL could point at the host itself or its
 * LAN (a router admin page, a metadata service), so every federation fetch on Node and Bun resolves
 * the host first and refuses loopback, private, link-local, CGNAT and unspecified addresses. The
 * operator's own configuration is trusted: an origin listed in FED_PEERS or FED_HUB_URL is allowed
 * whatever it resolves to, and FED_ALLOW_PRIVATE=1 lifts the check for an all-LAN network. Cloudflare
 * Workers need no guard — their egress never reaches a private network.
 *
 * The check runs before the fetch; a resolver that answers differently the second time (DNS
 * rebinding) is outside what a pre-flight check can see.
 */

/** Resolve a hostname to its addresses (Node's dns.lookup with `all: true`, Bun's equivalent). */
export type Resolve = (host: string) => Promise<string[]>;
/** Throws when the URL must not be fetched; resolves otherwise. */
export type FetchGuard = (url: string) => Promise<void>;

function v4Private(a: number[]): string | null {
  const [x, y] = a as [number, number];
  if (x === 127) return "loopback";
  if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return "private";
  if (x === 169 && y === 254) return "link-local";
  if (x === 100 && y >= 64 && y <= 127) return "private (CGNAT)";
  if (x === 0) return "unspecified";
  if (x >= 224) return "multicast/reserved";
  return null;
}

/** Why an IP literal must not be fetched, or null when it is a public address. */
export function blockedAddress(ip: string): string | null {
  const s = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) return v4Private(v4.slice(1).map(Number));
  if (!s.includes(":")) return null;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (mapped) return blockedAddress(mapped[1]!);
  if (s === "::1") return "loopback";
  if (s === "::") return "unspecified";
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return "private";
  if (/^fe[89ab][0-9a-f]:/.test(s)) return "link-local";
  if (/^ff[0-9a-f]{2}:/.test(s)) return "multicast";
  return null;
}

/**
 * A guard over `resolve`. `allowedOrigins` are the operator-configured origins exempt from the check;
 * `allowPrivate` lifts it entirely.
 */
export function createFetchGuard(opts: {
  resolve: Resolve;
  allowedOrigins?: string[];
  allowPrivate?: boolean;
}): FetchGuard {
  const allowed = new Set(
    (opts.allowedOrigins ?? []).flatMap((o) => {
      try {
        return [new URL(o).origin];
      } catch {
        return [];
      }
    }),
  );
  return async (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`refused: not a URL`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`refused: scheme ${u.protocol}`);
    if (opts.allowPrivate || allowed.has(u.origin)) return;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const literal = blockedAddress(host);
    if (literal) throw new Error(`refused: ${host} is a ${literal} address`);
    if (/^[\d.]+$/.test(host) || host.includes(":")) return; // a public IP literal
    if (host === "localhost" || host.endsWith(".localhost")) throw new Error(`refused: ${host} is loopback`);
    let addrs: string[];
    try {
      addrs = await opts.resolve(host);
    } catch {
      throw new Error(`refused: ${host} does not resolve`);
    }
    for (const a of addrs) {
      const why = blockedAddress(a);
      if (why) throw new Error(`refused: ${host} resolves to a ${why} address`);
    }
  };
}

/** The origins an operator configured by hand: FED_PEERS entries and FED_HUB_URL. */
export function operatorOrigins(env: { FED_PEERS?: string; FED_HUB_URL?: string }): string[] {
  return [...(env.FED_PEERS ?? "").split(","), env.FED_HUB_URL ?? ""].map((s) => s.trim()).filter(Boolean);
}

/**
 * The fetch every federation call makes: the runtime's guard (when it installed one on the env) runs
 * first. Workers install none.
 */
export async function fedFetch(
  env: { FED_FETCH_GUARD?: FetchGuard },
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (env.FED_FETCH_GUARD) await env.FED_FETCH_GUARD(url);
  return fetch(url, init);
}
