// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { ConnectedLink, type Ax25Address } from "@aprsweb/ax25";
import { LoopbackChannel } from "../src/loopback.js";
import { serveApp } from "../src/link-app.js";
import { BbsSession, type MessageStore, type BbsMsgMeta, type BbsMsgFull } from "../src/bbs.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const A = (call: string, ssid = 0): Ax25Address => ({ call, ssid });

/** Minimal in-memory MessageStore for the harness. */
function memStore(seed: Array<Omit<BbsMsgFull, "postedAt">>): MessageStore {
  const msgs: BbsMsgFull[] = seed.map((m) => ({ postedAt: 0, replyTo: null, ...m }));
  const meta = (m: BbsMsgFull): BbsMsgMeta => ({
    id: m.id,
    type: m.type,
    from: m.from,
    to: m.to,
    subject: m.subject,
    postedAt: m.postedAt,
  });
  return {
    listNew: (call) => msgs.filter((m) => m.type === "B" || (m.type === "P" && m.to === call)).map(meta),
    listAll: () => msgs.map(meta),
    listBulletins: () => msgs.filter((m) => m.type === "B").map(meta),
    listMine: (call) => msgs.filter((m) => m.from === call || m.to === call).map(meta),
    read: (id) => msgs.find((m) => m.id === id) ?? null,
    post: (m) => {
      const id = msgs.length + 1;
      msgs.push({ id, postedAt: 0, replyTo: m.replyTo ?? null, ...m });
      return id;
    },
    kill: (id) => {
      const i = msgs.findIndex((m) => m.id === id);
      if (i >= 0) {
        msgs.splice(i, 1);
        return true;
      }
      return false;
    },
  };
}

/** Wire a client link to a BBS-serving link over a loopback channel; collect what the client receives. */
function bbsOverLoopback(clientCall: string) {
  const ch = new LoopbackChannel();
  const clock = () => 0; // instant delivery → timers never fire; deterministic happy path
  const store = memStore([
    {
      id: 1,
      type: "B",
      from: "OE8XBM",
      to: "ALL",
      subject: "Net Tuesday 19:00",
      body: "Weekly packet net on 144.800.",
    },
    { id: 2, type: "P", from: "OE3ABC", to: clientCall, subject: "Hello", body: "Welcome to the BBS!" },
  ]);
  const server = serveApp(A("OE8BBS", 7), A(clientCall), new BbsSession(clientCall, store, "OE8BBS"), {
    send: ch.sendFromB,
    clock,
  });

  let rx = "";
  const client = new ConnectedLink(
    A(clientCall),
    A("OE8BBS", 7),
    {
      send: ch.sendFromA,
      deliver: (info) => {
        rx += dec(info);
      },
      state: () => {},
    },
    {},
    clock,
  );

  ch.attach(
    (f) => client.onReceive(f),
    (f) => server.onReceive(f),
  );
  return {
    client,
    server,
    take: () => {
      const s = rx;
      rx = "";
      return s;
    },
    connect: () => {
      client.connect();
      ch.pump();
    },
    cmd: (line: string) => {
      client.send(enc(line + "\r"));
      ch.pump();
    },
  };
}

describe("connected-mode BBS over the loopback harness", () => {
  it("completes the SABM/UA handshake and greets the caller", () => {
    const h = bbsOverLoopback("OE1TEST");
    h.connect();
    expect(h.client.state).toBe("connected");
    expect(h.server.state).toBe("connected");
    const greeting = h.take();
    expect(greeting).toContain("OE8BBS"); // the BBS banner
    expect(greeting).toContain("OE1TEST de OE8BBS>"); // the prompt addressed to the caller
  });

  it("lists and reads messages over the connected session", () => {
    const h = bbsOverLoopback("OE1TEST");
    h.connect();
    h.take();

    h.cmd("LB"); // list bulletins
    const list = h.take();
    expect(list).toContain("Net Tuesday 19:00");

    h.cmd("R 2"); // read the personal message
    const read = h.take();
    expect(read).toContain("Welcome to the BBS!");
  });

  it("disconnects cleanly on BYE", () => {
    const h = bbsOverLoopback("OE1TEST");
    h.connect();
    h.take();
    h.cmd("B"); // bye → server disconnects the link
    expect(h.client.state).toBe("disconnected");
    expect(h.server.state).toBe("disconnected");
  });
});
