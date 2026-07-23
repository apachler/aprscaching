// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal AX.25 connected-mode probe over AXUDP: dial a BBS callsign, print every line received,
// run a no-traffic FBB exchange (SID -> FF -> expect FQ). A debugging tool for the interop env.
import dgram from "node:dgram";
import {
  ConnectedLink,
  encodeFrame,
  decodeFrame,
  parseAddr,
  appendAxipCrc,
  stripAxipCrc,
} from "../../packages/ax25/src/index.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 10502);
const ME = parseAddr(process.env.ME ?? "OE1PRB-1");
const THEM = parseAddr(process.env.THEM ?? "OE1BBB-1");

const sock = dgram.createSocket("udp4");
sock.bind(10599);
const dec = new TextDecoder();
let buf = "";
const link = new ConnectedLink(ME, THEM, {
  send: (f) => sock.send(appendAxipCrc(encodeFrame(f)), PORT, HOST),
  deliver: (b) => {
    buf += dec.decode(b);
    let i;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  },
  state: (s) => console.log(`[link] ${s}`),
  error: (m) => console.log(`[link err] ${m}`),
});
sock.on("message", (m) => {
  const f = decodeFrame(stripAxipCrc(Uint8Array.from(m)));
  if (f) {
    console.log(
      `[rx] ${f.type} ${f.src.call}-${f.src.ssid}>${f.dst.call}-${f.dst.ssid} ${f.info ? JSON.stringify(dec.decode(f.info)) : ""}`,
    );
    link.onReceive(f);
  }
});
let sentSid = false;
function onLine(line) {
  console.log(`[line] ${JSON.stringify(line)}`);
  if (/^\[.+\]$/.test(line.trim()) && !sentSid) {
    sentSid = true;
    console.log("[tx] our SID + FF");
    link.send(new TextEncoder().encode("[PROBE-1.0-F$]\rFF\r"));
  }
  if (/^FQ/.test(line.trim())) {
    console.log("PROBE OK: FQ received");
    link.disconnect();
    setTimeout(() => process.exit(0), 500);
  }
}
setInterval(() => link.poll(), 500);
link.connect();
setTimeout(() => {
  console.log("PROBE TIMEOUT");
  process.exit(1);
}, 20000);
