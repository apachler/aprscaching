// SPDX-License-Identifier: AGPL-3.0-or-later
// Outbound connected-mode conformance vs a REAL LinBPQ: our LAPB initiator dials the BPQ node
// over AXUDP (frame + RFC 1226 CRC trailer) and must receive its CTEXT. Runs under tsx (imports
// the TS packages):  pnpm -C apps/ingest exec tsx ../../tools/interop/tests/bpq-dial.mjs
import dgram from "node:dgram";
import {
  ConnectedLink,
  encodeFrame,
  decodeFrame,
  parseAddr,
  appendAxipCrc,
  stripAxipCrc,
} from "../../../packages/ax25/src/index.js";

const HOST = process.env.BPQ_AXUDP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BPQ_AXUDP_PORT ?? 10093);
const ME = parseAddr(process.env.ME ?? "OE1PRB-1");
const THEM = parseAddr(process.env.THEM ?? "GB7BPQ"); // the BPQ NODECALL — its node answers with CTEXT

const sock = dgram.createSocket("udp4");
sock.bind(0); // ephemeral — BPQ's AUTOADDMAP learns our endpoint from the first frame
const dec = new TextDecoder();
let text = "";
const link = new ConnectedLink(ME, THEM, {
  send: (f) => sock.send(appendAxipCrc(encodeFrame(f)), PORT, HOST),
  deliver: (b) => {
    text += dec.decode(b);
    console.log(`[rx-text] ${JSON.stringify(dec.decode(b))}`);
    if (/interop BPQ node|Welcome/i.test(text)) {
      console.log("OK  our L2 initiator connected to LinBPQ and received its CTEXT");
      link.disconnect();
      setTimeout(() => process.exit(0), 500);
    }
  },
  state: (s) => console.log(`[link] ${s}`),
  error: (m) => console.log(`[link err] ${m}`),
});
sock.on("message", (m) => {
  const f = decodeFrame(stripAxipCrc(Uint8Array.from(m)));
  if (f) link.onReceive(f);
});
setInterval(() => link.poll(), 500);
link.connect();
setTimeout(() => {
  console.log(`FAIL no CTEXT from LinBPQ within 30s — transcript: ${JSON.stringify(text.slice(0, 300))}`);
  process.exit(1);
}, 30000);
