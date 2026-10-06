// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Field discovery on the local network: instances on one LAN or phone hotspot find each other by mDNS/DNS-SD,
 * with no internet and no address typed in. Used by the Node and Bun servers (FED_MDNS).
 *
 *   `listen`    ask for `_aprscaching._tcp.local` every few minutes and hand every answer to the gateway
 *   `announce`  listen, and also answer for this instance (and announce it unasked on the same cadence)
 *
 * An announcement carries a service instance named after the instance id, an SRV record with the http port,
 * and a TXT record: `id=<instance id>`, `fp=<key fingerprint>`, `path=/.well-known/aprscaching`. The address
 * taken for a found instance is the one its answer came from, never an A record it lists, so an answer can
 * point at no host but its sender. What is found is only listed (feddiscover.ts): switched off, unvetted,
 * never pulled until the sysop follows it.
 */
import { networkInterfaces } from "node:os";
import multicastDns from "multicast-dns";

export type MdnsMode = "off" | "listen" | "announce";
/** The DNS-SD service type. */
export const MDNS_SERVICE = "_aprscaching._tcp.local";
/** The descriptor path every announcement names. */
const DESCRIPTOR_PATH = "/.well-known/aprscaching";
/** Seconds a record lives in a listener's cache. */
const RECORD_TTL_S = 120;
/** How often a listener asks, and an announcer announces unasked. */
const DEFAULT_EVERY_MS = 5 * 60 * 1000;

/** The FED_MDNS mode of a server: its setting, else `listen` for a Pocket or Desktop instance, else `off`. */
export function mdnsMode(value: string | undefined, fieldShape: boolean): MdnsMode {
  return value === "listen" || value === "announce" || value === "off" ? value : fieldShape ? "listen" : "off";
}

/** What an announcer says about itself. */
export interface MdnsSelf {
  instance: string;
  /** Key fingerprint, as keyFingerprint() prints it. */
  fingerprint: string;
  /** The plain-http port the gateway answers on. */
  port: number;
}

/** An instance one answer names. */
export interface MdnsFound {
  instance: string;
  fingerprint: string;
  /** The base URL: the sender's address, the SRV port and the path in front of the descriptor. */
  address: string;
}

interface Rec {
  name: string;
  type: string;
  ttl?: number;
  data?: unknown;
}
interface Packet {
  questions?: { name: string; type: string }[];
  answers?: Rec[];
  additionals?: Rec[];
}
interface RInfo {
  address: string;
  family: string;
}
/** The part of a multicast-dns socket this module uses, so a test can stand in for it. */
export interface MdnsSocket {
  on(event: "response", cb: (p: Packet, rinfo: RInfo) => void): unknown;
  on(event: "query", cb: (p: Packet, rinfo: RInfo) => void): unknown;
  on(event: "error" | "warning", cb: (e: Error) => void): unknown;
  query(q: { questions: { name: string; type: string }[] }): void;
  respond(r: { answers: Rec[]; additionals?: Rec[] }): void;
  destroy(): void;
}

/** A DNS label for an instance id: its dots would split the name, so they become hyphens. */
const labelOf = (instance: string) => instance.replace(/\./g, "-").slice(0, 63);

/** The TXT strings of a record's data (dns-packet gives Buffers or strings). */
function txtPairs(data: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of Array.isArray(data) ? data : [data]) {
    const s = typeof item === "string" ? item : item instanceof Uint8Array ? new TextDecoder().decode(item) : "";
    const eq = s.indexOf("=");
    if (eq > 0) out.set(s.slice(0, eq).toLowerCase(), s.slice(eq + 1));
  }
  return out;
}

/** The instances one mDNS answer names. Pure; exported for the tests. */
export function parseAnnouncement(p: Packet, rinfo: RInfo): MdnsFound[] {
  // the sender's own IPv4 address: an IPv6 link-local address needs a zone a URL cannot carry
  if (String(rinfo.family) !== "IPv4" && String(rinfo.family) !== "4") return [];
  const records = [...(p.answers ?? []), ...(p.additionals ?? [])];
  const names = records
    .filter((r) => r.type === "PTR" && r.name.toLowerCase() === MDNS_SERVICE && typeof r.data === "string")
    .map((r) => r.data as string);
  const out: MdnsFound[] = [];
  for (const name of new Set(names)) {
    const srv = records.find((r) => r.type === "SRV" && r.name === name)?.data as { port?: unknown } | undefined;
    const txt = txtPairs(records.find((r) => r.type === "TXT" && r.name === name)?.data);
    const port = Number(srv?.port);
    const id = txt.get("id");
    const fp = txt.get("fp");
    const path = txt.get("path") ?? DESCRIPTOR_PATH;
    if (!id || !fp || !Number.isInteger(port) || port < 1 || port > 65535 || !path.endsWith(DESCRIPTOR_PATH)) continue;
    const prefix = path.slice(0, -DESCRIPTOR_PATH.length);
    if (prefix && !/^\/[A-Za-z0-9._~/-]*$/.test(prefix)) continue;
    out.push({ instance: id, fingerprint: fp, address: `http://${rinfo.address}:${port}${prefix}` });
  }
  return out;
}

/** This host's own IPv4 addresses, for the A records of an announcement. */
function ownAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

/** The records that announce `self`. Pure apart from the interface list; exported for the tests. */
export function announcement(self: MdnsSelf, addresses = ownAddresses()): { answers: Rec[]; additionals: Rec[] } {
  const label = labelOf(self.instance);
  const name = `${label}.${MDNS_SERVICE}`;
  const host = `${label}.local`;
  return {
    answers: [{ name: MDNS_SERVICE, type: "PTR", ttl: RECORD_TTL_S, data: name }],
    additionals: [
      { name, type: "SRV", ttl: RECORD_TTL_S, data: { port: self.port, target: host, weight: 0, priority: 0 } },
      {
        name,
        type: "TXT",
        ttl: RECORD_TTL_S,
        data: [`id=${self.instance}`, `fp=${self.fingerprint.replace(/\s/g, "")}`, `path=${DESCRIPTOR_PATH}`],
      },
      ...addresses.map((a) => ({ name: host, type: "A", ttl: RECORD_TTL_S, data: a })),
    ],
  };
}

/**
 * Start mDNS discovery. `self` is announced in `announce` mode only; without it (no instance id or no key)
 * the instance listens. Returns a stop function.
 */
export function startMdns(opts: {
  mode: MdnsMode;
  self?: MdnsSelf | null;
  onFound: (f: MdnsFound) => void;
  socket?: MdnsSocket;
  everyMs?: number;
}): { stop: () => void } {
  if (opts.mode === "off") return { stop: () => {} };
  const sock = opts.socket ?? (multicastDns() as unknown as MdnsSocket);
  const self = opts.mode === "announce" ? (opts.self ?? null) : null;
  sock.on("error", (e) => console.warn("mdns: %s", e.message));
  sock.on("warning", (e) => console.warn("mdns: %s", e.message));
  sock.on("response", (p, rinfo) => {
    for (const f of parseAnnouncement(p, rinfo)) if (f.instance !== self?.instance) opts.onFound(f);
  });
  const announce = () => self && sock.respond(announcement(self));
  if (self)
    sock.on("query", (p) => {
      const asked = (p.questions ?? []).some(
        (q) => q.name.toLowerCase() === MDNS_SERVICE && (q.type === "PTR" || q.type === "ANY"),
      );
      if (asked) announce();
    });
  const ask = () => sock.query({ questions: [{ name: MDNS_SERVICE, type: "PTR" }] });
  const tick = () => {
    try {
      ask();
      announce();
    } catch (e) {
      console.warn("mdns: %s", (e as Error).message);
    }
  };
  tick();
  const timer = setInterval(tick, opts.everyMs ?? DEFAULT_EVERY_MS);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      sock.destroy();
    },
  };
}
