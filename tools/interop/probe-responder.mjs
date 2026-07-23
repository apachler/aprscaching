// SPDX-License-Identifier: AGPL-3.0-or-later
// Log-everything AXUDP responder: answers a connected-mode dial to THEM with UA, prints every
// frame + line, greets with an SID, and behaves as a minimal FBB responder (FS + / FF / FQ).
import dgram from "node:dgram";
import { encodeFrame, decodeFrame, parseAddr, appendAxipCrc, stripAxipCrc } from "../../packages/ax25/src/index.js";
import { serveApp } from "../../packages/packet/src/link-app.js";

const PORT = Number(process.env.PORT ?? 10599);
const PEER = { host: "127.0.0.1", port: Number(process.env.PEER ?? 10501) };
const ME = parseAddr(process.env.ME ?? "OE1BBB-1");
const sock = dgram.createSocket("udp4");
sock.bind(PORT, () => console.log(`[responder] udp/${PORT} as ${ME.call}-${ME.ssid}`));
const dec = new TextDecoder();

let link = null;
let proposals = 0;
const app = {
  greeting: () => ["[PROBE-1.0-F$]", "Hello.", ">"],
  handle: (line) => {
    console.log(`[line<] ${JSON.stringify(line)}`);
    const t = line.trim();
    if (/^\[.+\]$/.test(t)) return { lines: [] };
    if (/^FB /i.test(t)) {
      proposals++;
      return { lines: [] };
    }
    if (/^F>/i.test(t)) {
      const fs = "FS " + "+".repeat(proposals);
      proposals = 0;
      return { lines: [fs] };
    }
    if (/^FF/i.test(t)) return { lines: ["FQ"], disconnect: true };
    if (/^FQ/i.test(t)) return { lines: [], disconnect: true };
    return { lines: [] }; // body lines / ^Z — swallow
  },
};

sock.on("message", (m) => {
  const f = decodeFrame(stripAxipCrc(Uint8Array.from(m)));
  if (!f) return console.log(`[rx] undecodable ${m.length}B`);
  console.log(
    `[rx] ${f.type} ${f.src.call}-${f.src.ssid}>${f.dst.call}-${f.dst.ssid}${f.info ? " " + JSON.stringify(dec.decode(f.info)) : ""}`,
  );
  if (f.dst.call !== ME.call || f.dst.ssid !== ME.ssid) return;
  if (!link && f.type === "SABM") {
    link = serveApp(ME, f.src, app, {
      send: (out) => {
        console.log(`[tx] ${out.type}${out.info ? " " + JSON.stringify(dec.decode(out.info)) : ""}`);
        sock.send(appendAxipCrc(encodeFrame(out)), PEER.port, PEER.host);
      },
      onState: (s) => console.log(`[state] ${s}`),
    });
  }
  link?.onReceive(f);
});
setInterval(() => link?.poll?.(), 500);
setTimeout(() => process.exit(0), 60000);
