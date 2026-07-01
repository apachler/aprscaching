import { describe, it, expect } from "vitest";
import { SessionServer } from "../src/session-server.js";
import { BbsSession, type MessageStore, type BbsMsgFull, type BbsMsgMeta } from "../src/bbs.js";
import { NodeSession, type NodeStore } from "../src/netrom.js";
import { ConnectedLink, type Ax25Address, type Ax25Frame } from "@aprsweb/ax25";

const A = (call: string, ssid = 0): Ax25Address => ({ call, ssid });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** A tiny in-memory BBS store with one bulletin + one personal message for OE1USER. */
function memStore(): MessageStore {
  const msgs: BbsMsgFull[] = [
    { id: 1, type: "B", from: "OE8APR", to: "ALL", subject: "Net Sunday", postedAt: 1000, body: "Net on 144.800 at 19:00." },
    { id: 2, type: "P", from: "OE8APR", to: "OE1USR", subject: "hi", postedAt: 1001, body: "welcome to the BBS" },
  ];
  const meta = (m: BbsMsgFull): BbsMsgMeta => ({ id: m.id, type: m.type, from: m.from, to: m.to, subject: m.subject, postedAt: m.postedAt });
  return {
    listNew: (call) => msgs.filter((m) => m.type === "B" || m.to === call).map(meta),
    listAll: () => msgs.map(meta),
    listBulletins: () => msgs.filter((m) => m.type === "B").map(meta),
    listMine: (call) => msgs.filter((m) => m.from === call || m.to === call).map(meta),
    read: (id) => msgs.find((m) => m.id === id) ?? null,
    post: () => 99,
    kill: () => true,
  };
}

const nodeStore: NodeStore = {
  nodes: () => [{ alias: "GRZ", call: "OE8NOD-2", quality: 200 }],
  routes: () => [{ neighbor: "OE8NOD-2", port: "kiss-tnc", quality: 200 }],
  users: () => [{ call: "OE1USR" }],
  mheard: () => [{ call: "OE3XYZ", port: "kiss-tnc", lastHeard: 1000 }],
  info: () => "APRScaching NET/ROM node",
};

/**
 * Connect a client ConnectedLink INTO a SessionServer over a deferred frame bridge (the re-entrancy-safe
 * loopback pattern), drive the given command lines, and return everything the server delivered back.
 */
function converse(server: SessionServer, service: Ax25Address, me: Ax25Address, lines: string[]): { rx: string; client: ConnectedLink } {
  const q: Array<{ to: "server" | "client"; f: Ax25Frame }> = [];
  let rx = "";
  const client = new ConnectedLink(me, service, {
    send: (f) => q.push({ to: "server", f }),
    deliver: (b) => { rx += dec(b); },
    state: () => {},
  });
  // the server's outbound frames come back to the client
  (server as unknown as { o: { send: (f: Ax25Frame) => void } }).o.send = (f) => q.push({ to: "client", f });
  const pump = (guard = 5000) => { while (q.length && guard-- > 0) { const { to, f } = q.shift()!; if (to === "server") server.onFrame(f); else client.onReceive(f); } };

  client.connect(); pump();                    // SABM → UA + greeting
  for (const line of lines) { client.send(enc(line + "\r")); pump(); }
  return { rx, client };
}

describe("connected-mode session server (docs/29 F1)", () => {
  it("answers an inbound connect to the BBS and drives L / R / B", () => {
    const events: string[] = [];
    const server = new SessionServer({
      send: () => {}, // replaced by converse()
      services: [{ addr: A("OE8BBS"), name: "BBS", app: (remote) => new BbsSession(remote.call, memStore(), "OE8BBS") }],
      onEvent: (e) => events.push(`${e.kind}:${e.remote}`),
    });

    const { rx } = converse(server, A("OE8BBS"), A("OE1USR"), ["L", "R 1", "B"]);

    expect(rx).toContain("[APRScaching BBS OE8BBS]");   // greeting on connect
    expect(rx).toContain("Hello OE1USR");
    expect(rx).toContain("Net Sunday");                  // L listed the bulletin
    expect(rx).toContain("Net on 144.800 at 19:00.");    // R 1 read its body
    expect(rx).toContain("73");                          // B said goodbye
    expect(server.count()).toBe(0);                      // session cleaned up after disconnect
    expect(events[0]).toBe("connect:OE1USR");
    expect(events.at(-1)).toBe("disconnect:OE1USR");
  });

  it("answers an inbound connect to the NET/ROM node and lists NODES", () => {
    const server = new SessionServer({
      send: () => {},
      services: [{ addr: A("OE8NOD", 1), name: "NODE", app: (r) => new NodeSession(r.call, nodeStore, "GRAZ", "OE8NOD-1") }],
    });
    const { rx } = converse(server, A("OE8NOD", 1), A("OE1USR"), ["N", "B"]);
    expect(rx).toContain("NET/ROM node");
    expect(rx).toContain("GRZ:OE8NOD-2");                // the node list
    expect(server.count()).toBe(0);
  });

  it("ignores frames addressed to a call we do not serve", () => {
    let sent = 0;
    const server = new SessionServer({
      send: () => { sent++; },
      services: [{ addr: A("OE8BBS"), app: (r) => new BbsSession(r.call, memStore()) }],
    });
    // a SABM to some other station → not ours → no session, nothing sent
    server.onFrame({ dst: A("OE9XXX"), src: A("OE1USR"), command: true, type: "SABM", pf: true });
    expect(server.count()).toBe(0);
    expect(sent).toBe(0);
  });

  it("enforces maxSessions (refuses a new caller at capacity)", () => {
    const refused: string[] = [];
    const server = new SessionServer({
      send: () => {},
      services: [{ addr: A("OE8BBS"), app: (r) => new BbsSession(r.call, memStore()) }],
      maxSessions: 1,
      onEvent: (e) => { if (e.kind === "refused") refused.push(e.remote); },
    });
    server.onFrame({ dst: A("OE8BBS"), src: A("OE1AAA"), command: true, type: "SABM", pf: true });
    server.onFrame({ dst: A("OE8BBS"), src: A("OE2BBB"), command: true, type: "SABM", pf: true });
    expect(server.count()).toBe(1);
    expect(refused).toEqual(["OE2BBB"]);
  });
});
