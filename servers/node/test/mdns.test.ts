// SPDX-License-Identifier: AGPL-3.0-or-later
// mDNS field discovery: an announcer answers a listener's question for `_aprscaching._tcp.local` with its
// instance id, key fingerprint, port and descriptor path, and the listener takes the address the answer came
// from. The sockets are a loopback bus standing in for the multicast group.
import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import {
  MDNS_SERVICE,
  announcement,
  mdnsMode,
  parseAnnouncement,
  startMdns,
  type MdnsFound,
  type MdnsSocket,
} from "../src/mdns.js";

/** Sockets on one segment: a query reaches every other socket, an answer too, each from its sender's address. */
function bus() {
  const sockets: { em: EventEmitter; address: string }[] = [];
  const join = (address: string): MdnsSocket => {
    const em = new EventEmitter();
    sockets.push({ em, address });
    const send = (event: string, packet: unknown) => {
      for (const s of sockets) if (s.em !== em) s.em.emit(event, structuredClone(packet), { address, family: "IPv4" });
    };
    return {
      on: (event: string, cb: (...a: any[]) => void) => em.on(event, cb),
      query: (q) => send("query", q),
      respond: (r) => send("response", r),
      destroy: () => em.removeAllListeners(),
    } as MdnsSocket;
  };
  return { join };
}

const SELF = { instance: "pocket.oe8apr.example", fingerprint: "3f2a 9c01 bb7e 4d10", port: 8787 };

describe("mDNS discovery", () => {
  it("a listener finds an announcer at the address its answer came from", () => {
    const net = bus();
    const found: MdnsFound[] = [];
    const announcer = startMdns({ mode: "announce", self: SELF, onFound: () => {}, socket: net.join("192.168.43.7") });
    const listener = startMdns({ mode: "listen", onFound: (f) => found.push(f), socket: net.join("192.168.43.20") });
    expect(found).toContainEqual({
      instance: SELF.instance,
      fingerprint: "3f2a9c01bb7e4d10",
      address: "http://192.168.43.7:8787",
    });
    announcer.stop();
    listener.stop();
  });

  it("a listener never answers, and an announcer does not report itself", () => {
    const net = bus();
    const heard: MdnsFound[] = [];
    const responses: unknown[] = [];
    const probe = net.join("192.168.43.30");
    probe.on("response", (p) => responses.push(p));
    const a = startMdns({ mode: "announce", self: SELF, onFound: (f) => heard.push(f), socket: net.join("10.0.0.2") });
    const l = startMdns({ mode: "listen", self: SELF, onFound: () => {}, socket: net.join("10.0.0.3") });
    responses.length = 0;
    probe.query({ questions: [{ name: MDNS_SERVICE, type: "PTR" }] });
    expect(responses).toHaveLength(1); // the announcer's answer only
    expect(heard).toEqual([]);
    a.stop();
    l.stop();
  });

  it("parses TXT strings sent as bytes, and refuses incomplete or odd answers", () => {
    const { answers, additionals } = announcement(SELF, ["192.168.43.7"]);
    const bytes = additionals.map((r) =>
      r.type === "TXT" ? { ...r, data: (r.data as string[]).map((t) => new TextEncoder().encode(t)) } : r,
    );
    const rinfo = { address: "192.168.43.7", family: "IPv4" };
    expect(parseAnnouncement({ answers, additionals: bytes }, rinfo)).toHaveLength(1);
    expect(parseAnnouncement({ answers, additionals: bytes }, { address: "fe80::1", family: "IPv6" })).toEqual([]);
    const noTxt = additionals.filter((r) => r.type !== "TXT");
    expect(parseAnnouncement({ answers, additionals: noTxt }, rinfo)).toEqual([]);
    const badPath = additionals.map((r) =>
      r.type === "TXT" ? { ...r, data: ["id=x.example", "fp=00", "path=/x"] } : r,
    );
    expect(parseAnnouncement({ answers, additionals: badPath }, rinfo)).toEqual([]);
  });

  it("listens on a Pocket or Desktop instance and stays off on a server unless set", () => {
    expect(mdnsMode(undefined, true)).toBe("listen");
    expect(mdnsMode(undefined, false)).toBe("off");
    expect(mdnsMode("off", true)).toBe("off");
    expect(mdnsMode("announce", false)).toBe("announce");
  });
});
