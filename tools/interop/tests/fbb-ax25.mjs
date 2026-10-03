// SPDX-License-Identifier: AGPL-3.0-or-later
// F6FBB over kernel AX.25: our LAPB initiator connects to the BBS call OE9FBB-1 over AXUDP. The frames
// travel AXUDP → ax25ipd → the kernel's mkiss port → xfbbd and back, and FBB must answer with its SID.
// ax25ipd has no address learning, so this binds the fixed port its route for OE1PRB-2 names
// (tools/interop/fbb/ax25ipd.conf). Runs under tsx (imports the TS packages):
//   pnpm -C apps/ingest exec tsx ../../tools/interop/tests/fbb-ax25.mjs
import dgram from "node:dgram";
import {
  ConnectedLink,
  encodeFrame,
  decodeFrame,
  parseAddr,
  appendAxipCrc,
  stripAxipCrc,
} from "../../../packages/ax25/src/index.js";

const HOST = process.env.FBB_AXUDP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.FBB_AXUDP_PORT ?? 10093);
const LOCAL_PORT = Number(process.env.FBB_DIAL_PORT ?? 10094);
const ME = parseAddr(process.env.ME ?? "OE1PRB-2");
const THEM = parseAddr(process.env.THEM ?? "OE9FBB-1");

const sock = dgram.createSocket("udp4");
sock.bind(LOCAL_PORT);
const dec = new TextDecoder();
let text = "";
let state = "disconnected";
const link = new ConnectedLink(ME, THEM, {
  send: (f) => sock.send(appendAxipCrc(encodeFrame(f)), PORT, HOST),
  deliver: (b) => {
    text += dec.decode(b);
    console.log(`[rx-text] ${JSON.stringify(dec.decode(b))}`);
    if (/\[FBB-[^\]]*\$\]/.test(text)) {
      console.log("OK  our L2 initiator connected to F6FBB over AXUDP → ax25ipd → kernel AX.25 and received its SID");
      link.disconnect();
      setTimeout(() => process.exit(0), 1000);
    }
  },
  state: (s) => {
    state = s;
    console.log(`[link] ${s}`);
  },
  error: (m) => console.log(`[link err] ${m}`),
});
sock.on("message", (m) => {
  const f = decodeFrame(stripAxipCrc(Uint8Array.from(m)));
  if (f) link.onReceive(f);
});
setInterval(() => link.poll(), 500);
sock.on("listening", () => link.connect());
setTimeout(() => {
  console.log(
    `FAIL no FBB SID over AX.25 within 45s (link ${state}) — transcript: ${JSON.stringify(text.slice(0, 300))}`,
  );
  process.exit(1);
}, 45000);
