// SPDX-License-Identifier: AGPL-3.0-or-later
// KISS TCP conformance vs the kernel Linux AX.25 stack: our KissTnc client (apps/ingest) dials the
// `ax25kernel` container's KISS TCP port, behind which kissnetd joins the kernel's mkiss port (kissattach),
// the TCP bridge and a wire tap. Asserted: FEND/FESC escaping both ways, the KISS type byte (port and
// command nibbles) both ways, frame boundaries under bursts, UI frames both ways, and an AX.25 connect —
// modulo 8 and modulo 128 — to an ax25d service that echoes a line. Runs under tsx (imports the TS
// sources):  pnpm -C apps/ingest exec tsx ../../tools/interop/tests/kiss-kernel.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KissTnc } from "../../../apps/ingest/src/kiss.js";
import { kissDecode, kissWrap } from "../../../packages/aprs/src/index.js";
import { ConnectedLink, decodeFrame, parseAddr } from "../../../packages/ax25/src/index.js";

const HOST = process.env.KISS_HOST ?? "127.0.0.1";
const PORT = Number(process.env.KISS_PORT ?? 8001);
const COMPOSE = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
const ME = "OE1ACS-5"; // our client's call
const KPORT = "OE9KRN-1"; // the kernel port's call (axports)
const KUI = "OE9KRN-3"; // the source of the kernel's UI frames
const KSVC = "OE9KRN-2"; // the ax25d service

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(50);
  return cond();
};
const hex = (b) => Buffer.from(b).toString("hex");
const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const kernel = (...args) =>
  execFileSync("docker", ["compose", "-f", COMPOSE, "--profile", "ax25kernel", "exec", "-T", "ax25kernel", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
const kernelLog = (file) =>
  kernel("cat", file)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [tag, h] = l.split(" ");
      return { tag, bytes: Uint8Array.from(Buffer.from(h ?? "", "hex")) };
    });
/** An AX.25 frame's source call (the second address), or "" when it is too short to have one. */
const srcCall = (frame) => (frame.length >= 14 ? (decodeFrame(frame)?.src ?? null) : null);
const callStr = (a) => (a ? (a.ssid ? `${a.call}-${a.ssid}` : a.call) : "");
/** The tap's frames, each split into its KISS type byte, its escaped wire bytes and its AX.25 frame. */
const tapFrames = () =>
  kernelLog("/tmp/tap.log").map(({ bytes: wire }) => {
    const [k] = kissDecode(Uint8Array.from([0xc0, ...wire, 0xc0]));
    return { type: wire[0], wire, frame: k?.frame ?? new Uint8Array(), src: callStr(srcCall(k?.frame ?? [])) };
  });
const infoOf = (frame) => decodeFrame(frame)?.info ?? new Uint8Array();
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ------------------------------------------------------------------ the container is up
ok(
  "kernel AX.25 container is ready",
  await until(() => {
    try {
      kernel("test", "-e", "/tmp/ready");
      return true;
    } catch {
      return false;
    }
  }, 90000),
);

// ------------------------------------------------------------------ our KISS TCP client
const rx = []; // every raw AX.25 frame KissTnc delivered
let onRaw = () => {};
const kiss = new KissTnc(
  { host: HOST, port: PORT, retryMs: 500 },
  {
    onPacket: () => {},
    onRaw: (b) => {
      rx.push(b);
      onRaw(b);
    },
  },
);
kiss.start();
ok("KissTnc connects to the KISS TCP port", await until(() => kiss["connected"], 15000));
await sleep(500);

// ------------------------------------------------------------------ kernel → us: mkiss's CRC probe
// mkiss in its default auto mode sends its first frame with a SMACK CRC (type 0x80) and its second with a
// FlexNet CRC (type 0x20); with no CRC'd frame back it settles on plain KISS (type 0x00).
kernel("axkit", "ui", KPORT, KUI, "APZKRN", hex(bytes("probe")), "3");
await until(() => rx.filter((f) => callStr(srcCall(f)) === KUI).length >= 3, 5000);
const probes = tapFrames().filter((f) => f.src === KUI);
ok(
  "the kernel's first frames carry mkiss's CRC probes, port nibble 8 then 2",
  probes[0]?.type === 0x80 && probes[1]?.type === 0x20,
  `types ${probes.map((f) => f.type?.toString(16)).join(",")}`,
);
ok(
  "after the probe the kernel sends plain KISS data (type 0x00)",
  probes.length >= 3 && probes.slice(2).every((f) => f.type === 0x00),
  `types ${probes.map((f) => f.type?.toString(16)).join(",")}`,
);
const probeRx = rx.filter((f) => callStr(srcCall(f)) === KUI);
ok(
  "our client checks and strips both probes' CRC, and reads them as the plain frame (bar axkit's frame number)",
  probeRx.length >= 3 &&
    probeRx.slice(0, 2).every((f) => Buffer.from(f.subarray(0, -2)).equals(Buffer.from(probeRx[2].subarray(0, -2)))),
  `lengths ${probeRx.map((f) => f.length).join(",")}`,
);

// ------------------------------------------------------------------ kernel → us: escaping
const SPECIAL = Uint8Array.from([...bytes("esc:"), 0xc0, 0xdb, 0xc0, 0xc0, 0xdb, 0xdc, 0xdd, 0xdb, ...bytes(":end")]);
rx.length = 0;
kernel("axkit", "ui", KPORT, KUI, ME, hex(SPECIAL));
await until(() => rx.some((f) => callStr(srcCall(f)) === KUI), 5000);
const escIn = rx.find((f) => callStr(srcCall(f)) === KUI);
ok(
  "a kernel UI frame holding FEND/FESC bytes reaches us byte-exact",
  !!escIn && sameBytes(infoOf(escIn), SPECIAL),
  escIn ? hex(infoOf(escIn)) : "nothing received",
);
const escWire = tapFrames()
  .filter((f) => f.src === KUI)
  .at(-1);
ok(
  "the kernel escaped them on the wire (FESC TFEND / FESC TFESC, no bare FEND)",
  !!escWire && hex(escWire.wire).includes("dbdcdbdddbdcdbdc") && !escWire.wire.includes(0xc0),
  escWire ? hex(escWire.wire) : "no tap frame",
);

// ------------------------------------------------------------------ kernel → us: a burst keeps its boundaries
rx.length = 0;
const N = 25;
kernel("axkit", "ui", KPORT, KUI, ME, hex(bytes("burst")), String(N));
await until(() => rx.filter((f) => callStr(srcCall(f)) === KUI).length >= N, 8000);
const burstIn = rx.filter((f) => callStr(srcCall(f)) === KUI).map((f) => new TextDecoder("latin1").decode(infoOf(f)));
const wantBurst = Array.from({ length: N }, (_, i) => `burst#${String(i).padStart(2, "0")}`);
ok(
  `a burst of ${N} kernel frames arrives whole, in order, each once`,
  JSON.stringify(burstIn) === JSON.stringify(wantBurst),
  JSON.stringify(burstIn),
);

// ------------------------------------------------------------------ us → kernel: escaping, type byte, burst
const latin1 = (b) => String.fromCharCode(...b);
ok("KissTnc sends a UI frame", kiss.send({ src: ME, dst: KPORT, payload: latin1(SPECIAL) }));
for (let i = 0; i < N; i++) kiss.send({ src: ME, dst: KPORT, payload: `out#${String(i).padStart(2, "0")}` });
await sleep(2000);
const monIn = kernelLog("/tmp/mon.log").filter((l) => l.tag === "in" && callStr(srcCall(l.bytes.slice(1))) === ME);
const escOut = monIn.find((l) => sameBytes(infoOf(l.bytes.slice(1)), SPECIAL));
ok(
  "the kernel decodes our UI frame holding FEND/FESC bytes byte-exact",
  !!escOut,
  monIn.map((l) => hex(l.bytes)).join(" | ") || "the kernel received nothing from us",
);
ok("the kernel reads our frames as KISS data on port 0", monIn.length > 0 && monIn.every((l) => l.bytes[0] === 0x00));
const outBurst = monIn
  .map((l) => new TextDecoder("latin1").decode(infoOf(l.bytes.slice(1))))
  .filter((s) => s.startsWith("out#"));
ok(
  `the kernel receives our burst of ${N} frames whole, in order, each once`,
  JSON.stringify(outBurst) === JSON.stringify(Array.from({ length: N }, (_, i) => `out#${String(i).padStart(2, "0")}`)),
  JSON.stringify(outBurst),
);
const ourWire = tapFrames().filter((f) => f.src === ME);
const ourEsc = ourWire.find((f) => sameBytes(infoOf(f.frame), SPECIAL));
ok(
  "our client escapes FEND/FESC on the wire and sends type 0x00",
  !!ourEsc &&
    ourWire.every((f) => f.type === 0x00) &&
    hex(ourEsc.wire).includes("dbdcdbdddbdcdbdc") &&
    sameBytes(ourEsc.wire, kissWrap(ourEsc.frame).slice(1, -1)),
  ourEsc ? hex(ourEsc.wire) : "no tap frame from us",
);

// ------------------------------------------------------------------ connected mode vs ax25d
async function session(modulo) {
  const label = `modulo ${modulo}`;
  let text = "";
  const states = [];
  const errors = [];
  const link = new ConnectedLink(
    parseAddr(ME),
    parseAddr(KSVC),
    {
      send: (f) => kiss.sendFrame(f),
      deliver: (b) => {
        text += latin1(b);
      },
      state: (s) => states.push(s),
      error: (m) => errors.push(m),
    },
    { modulo },
  );
  onRaw = (b) => {
    const f = decodeFrame(b, link.extended);
    if (f) link.onReceive(f);
  };
  const timer = setInterval(() => link.poll(), 200);
  link.connect();
  const greeting = `KERNEL AX25 interop ${ME}\r`;
  ok(`${label}: connect to ${KSVC} on ax25d`, await until(() => link.state === "connected", 10000), states.join(">"));
  ok(
    `${label}: the service greets us by the call the kernel decoded`,
    await until(() => text.includes(greeting), 10000),
    JSON.stringify(text),
  );
  const line = latin1(Uint8Array.from([...bytes("ping "), 0xc0, 0xdb, 0xdc, 0xdd, ...bytes(" done")]));
  link.send(bytes(`${line}\r`));
  ok(
    `${label}: an I-frame holding FEND/FESC bytes is echoed back byte-exact`,
    await until(() => text.includes(`ECHO ${line}\r`), 10000),
    JSON.stringify(text),
  );
  link.disconnect();
  ok(
    `${label}: DISC is acknowledged and the link closes cleanly`,
    (await until(() => link.state === "disconnected", 10000)) && errors.length === 0,
    `${states.join(">")} ${errors.join("; ")}`,
  );
  clearInterval(timer);
  onRaw = () => {};
}
await session(8);
await session(128);

console.log(failures ? `\nKISS KERNEL INTEROP FAILED (${failures})` : "\nKISS KERNEL INTEROP PASSED");
process.exit(failures ? 1 : 0);
