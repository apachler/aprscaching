// SPDX-License-Identifier: AGPL-3.0-or-later
// Full FBB mail exchange against a REAL F6FBB over its telnet port: our forwarding session engine
// (`FbbForwarder` from @aprscaching/packet, the one the ingest runs over AX.25) logs in as the
// registered BBS partner OE1ACS and forwards a personal message — proposal, FS verdict, delivery.
// A second session re-proposes the same BID and must be refused (BID dedup), the message must be
// readable in FBB's mailbox by its addressee, and FBB must reverse-forward a message addressed to
// OE1ACS back to us. The container registers both callsigns through the xfbbC sysop console at
// start (tools/interop/fbb/start.sh). Runs under tsx (imports the TS packages):
//
//   pnpm -C apps/ingest exec tsx ../../tools/interop/tests/fbb-forward.mjs
import net from "node:net";
import { FbbForwarder } from "../../../packages/packet/src/index.js";

const HOST = process.env.FBB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.FBB_PORT ?? 6300);
const PARTNER = { call: "OE1ACS", pass: process.env.FBB_PARTNER_PASS ?? "interop1" };
const USER = { call: "OE1TST", pass: process.env.FBB_USER_PASS ?? "interop2" };
const FBB_BBS = "OE9FBB";
const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const BID = `${RUN}OE1ACS`; // an FBB BID is at most 12 characters: a longer one is deferred (FS =)
const TITLE = `Interop ${RUN}`;
const BODY = `Forwarded by APRScaching to F6FBB.\nRun ${RUN}.`;
const BACK_TITLE = `Back ${RUN}`;
const BACK_BODY = `Reverse-forwarded by F6FBB, run ${RUN}.`;

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK " : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (s) => JSON.stringify(s.length > 600 ? s.slice(-600) : s);

/** A telnet line session: log in at FBB's `Callsign :` / `Password :` prompts, then expose the socket. */
function login(user) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST);
    let out = "";
    let step = 0;
    const onData = (b) => {
      out += b.toString("latin1");
      if (step === 0 && /Callsign\s*:/i.test(out)) {
        step = 1;
        sock.write(`${user.call}\r`);
      } else if (step === 1 && /Password\s*:/i.test(out)) {
        step = 2;
        sock.write(`${user.pass}\r`);
      } else if (step === 2 && /(>\s*$|\[[^\]]*\$\])/m.test(out.slice(out.search(/Password\s*:/i)))) {
        step = 3;
        sock.off("data", onData);
        resolve({ sock, greeting: out });
      }
    };
    sock.on("data", onData);
    sock.on("error", reject);
    setTimeout(
      () => step < 3 && (sock.destroy(), reject(new Error(`login ${user.call} stalled: ${show(out)}`))),
      15000,
    );
  });
}

/** One forwarding session as the initiator: our SID + proposals, FBB's FS, delivery, reverse forward, FQ. */
async function forwardSession(store) {
  const { sock, greeting } = await login(PARTNER);
  const wire = { rx: greeting, tx: "" };
  const fwd = new FbbForwarder(store, { initiator: true });
  const send = (bytes) => {
    if (!bytes) return;
    wire.tx += Buffer.from(bytes).toString("latin1");
    sock.write(bytes);
  };
  await new Promise((resolve) => {
    sock.on("data", (b) => {
      wire.rx += b.toString("latin1");
      send(fwd.onData(new Uint8Array(b)));
      if (fwd.done) setTimeout(resolve, 500);
    });
    sock.on("close", resolve);
    send(fwd.start());
    setTimeout(resolve, 30000);
  });
  sock.destroy();
  return { ...wire, done: fwd.done };
}

/** An in-memory FbbStore: one outbound message queue + whatever FBB forwards to us. */
function memStore(outbound) {
  const queue = [...outbound];
  const received = [];
  return {
    received,
    outbound: () => queue,
    hasBid: (bid) => received.some((m) => m.bid === bid),
    accept: (m) => received.push(m),
    sent: (bid) => {
      const i = queue.findIndex((m) => m.bid === bid);
      if (i >= 0) queue.splice(i, 1);
    },
    queued: () => queue.length,
  };
}

/** Run user-console commands (each sent once the previous one's prompt is back). */
async function userConsole(user, lines, settleMs = 1200) {
  const { sock, greeting } = await login(user);
  let out = greeting;
  sock.on("data", (b) => (out += b.toString("latin1")));
  for (const l of lines) {
    sock.write(`${l}\r`);
    await sleep(settleMs);
  }
  sock.write("B\r");
  await sleep(500);
  sock.destroy();
  return out;
}

const msg = { type: "P", from: PARTNER.call, at: FBB_BBS, to: USER.call, bid: BID, title: TITLE, body: BODY };

// FBB → us: OE1TST writes a personal message to OE1ACS; forward.sys routes @OE1ACS to the partner,
// so FBB holds it for reverse forwarding in the next session.
const posted = await userConsole(USER, [`SP ${PARTNER.call} @ ${PARTNER.call}`, BACK_TITLE, BACK_BODY, "\x1a"]);
ok(
  "FBB stores a user message @OE1ACS and routes it to the partner (forward.sys)",
  new RegExp(`Message # \\d+ is sent @ ${PARTNER.call}`).test(posted),
  show(posted),
);

// 1. ours → FBB: proposal, accepted, delivered; FBB's queued message comes back the other way.
const s1 = memStore([msg]);
const first = await forwardSession(s1);
ok("FBB greets the registered partner with its SID", /\[FBB-[^\]]*F[^\]]*\$\]/.test(first.rx), show(first.rx));
ok(
  "our SID and FB proposal go out",
  /\[ACG-[^\]]*\]/.test(first.tx) && first.tx.includes(`FB P ${PARTNER.call} ${FBB_BBS} ${USER.call} ${BID} `),
  show(first.tx),
);
ok("FBB accepts the proposal (FS +)", /^FS \+/m.test(first.rx.replace(/\r/g, "\n")), show(first.rx));
ok(
  "the message is delivered and dequeued",
  first.tx.includes(TITLE) && first.tx.includes("\x1a") && s1.queued() === 0,
  show(first.tx),
);
const back = s1.received.find((m) => m.title === BACK_TITLE);
ok(
  "FBB reverse-forwards the message addressed to OE1ACS",
  back && back.to === PARTNER.call && back.from === USER.call && back.body.includes(BACK_BODY),
  `received ${JSON.stringify(s1.received)} -- rx ${show(first.rx)}`,
);
ok("the session closes cleanly (FQ)", first.done || /FQ/.test(first.rx) || /FQ/.test(first.tx), show(first.rx));

// 2. BID dedup: the same BID proposed again is refused and never delivered twice.
await sleep(1500);
const s2 = memStore([msg]);
const second = await forwardSession(s2);
ok("re-proposing the same BID is refused (FS -)", /^FS -/m.test(second.rx.replace(/\r/g, "\n")), show(second.rx));
ok("the refused message is not sent again", !second.tx.includes(TITLE) && s2.queued() === 0, show(second.tx));
ok(
  "FBB does not forward the delivered message twice",
  !s2.received.some((m) => m.title === BACK_TITLE),
  JSON.stringify(s2.received),
);

// 3. The message sits in FBB's mailbox for its addressee.
const listing = await userConsole(USER, ["LM"]);
const num = listing.match(new RegExp(`^\\s*(\\d+)\\s.*${TITLE}`, "m"))?.[1];
ok("FBB lists the message in OE1TST's mailbox", !!num, show(listing));
if (num) {
  const read = await userConsole(USER, [`R ${num}`]);
  ok("FBB shows the forwarded body", read.includes(`Run ${RUN}.`) && read.includes(BID), show(read));
}

console.log(failures ? `\nFBB FORWARD FAILED (${failures})` : "\nFBB FORWARD PASSED");
process.exit(failures ? 1 : 0);
