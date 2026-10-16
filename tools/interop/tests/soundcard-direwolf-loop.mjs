// SPDX-License-Identifier: AGPL-3.0-or-later
// The ingest's soundcard port (Direwolf's modem in WebAssembly) against native Direwolf, over the UDP audio cable
// of direwolf/start.sh. One native Direwolf per framing (dw-sc-ax25, dw-sc-fx25, dw-sc-il2p), each transmitting
// in it; for each, a soundcard port with the same SOUNDCARD_FEC:
//   soundcard port -> audio -> native Direwolf: the port transmits, Direwolf's KISS port delivers the frame.
//   native Direwolf -> audio -> soundcard port: Direwolf transmits what our KISS client hands it, and the port
//                                              hears it as a local RF hearing of its receiving site.
// The port's arecord and aplay are UDP sockets here: capture reads the datagrams Direwolf's cable sends (and
// silence between them, as a sound card delivers), playback sends the port's audio to Direwolf's `udp:` input.
// Runs under tsx (imports the ingest's TS sources):
//   pnpm -C apps/ingest exec tsx ../../tools/interop/tests/soundcard-direwolf-loop.mjs
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { KissTnc } from "../../../apps/ingest/src/kiss.js";
import { SoundcardPort } from "../../../apps/ingest/src/soundcard.js";

const HOST = process.env.DW_HOST ?? "127.0.0.1";
const RATE = 48000;
const SITE = "OE1SCP-10";
const TOCALL = "APZACG";
const run = Date.now().toString(36); // payloads carry the run id, so a stale frame never satisfies a check
const LEGS = [
  { fec: "off", name: "ax25", kiss: 38011, audio: 38355, listen: 38455 },
  { fec: "fx25", name: "fx25", kiss: 38012, audio: 38356, listen: 38456 },
  { fec: "il2p", name: "il2p", kiss: 38013, audio: 38357, listen: 38457 },
].map((l) => {
  const env = (k, d) => Number(process.env[`DW_SC_${l.name.toUpperCase()}_${k}`] ?? d);
  return {
    ...l,
    kiss: env("KISS_PORT", l.kiss),
    audio: env("AUDIO_PORT", l.audio),
    listen: env("LISTEN_PORT", l.listen),
  };
});

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK " : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(deadlineMs, check, everyMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > deadlineMs) return null;
    await sleep(everyMs);
  }
}

/** An audio child: `arecord` listens on `listen`, `aplay` sends to Direwolf's `udp:` input at `audio`. */
function udpSpawn(leg) {
  return (cmd) => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: null,
      kill() {
        if (child.exitCode !== null) return false;
        child.exitCode = 0;
        cleanup();
        setImmediate(() => child.emit("exit", null, "SIGTERM"));
        return true;
      },
    });
    let cleanup = () => {};
    if (cmd === "arecord") {
      const sock = dgram.createSocket("udp4");
      let heard = 0;
      sock.on("message", (b) => {
        heard += b.length;
        child.stdout.emit("data", b);
      });
      sock.bind(leg.listen);
      // a sound card delivers audio all the time: silence fills the gaps between Direwolf's transmissions
      const silence = Buffer.alloc((RATE / 10) * 2);
      const t = setInterval(() => {
        if (!heard) child.stdout.emit("data", silence);
        heard = 0;
      }, 100);
      cleanup = () => {
        clearInterval(t);
        sock.close();
      };
    } else {
      const sock = dgram.createSocket("udp4");
      const parts = [];
      cleanup = () => sock.close();
      child.stdin = {
        write: (b) => parts.push(Buffer.from(b)) > 0,
        on: () => {},
        end: async () => {
          const audio = Buffer.concat(parts);
          // 1024-byte datagrams (Direwolf reads at most 2000 bytes of each), at twice real time
          for (let i = 0; i < audio.length; i += 1024) {
            sock.send(audio.subarray(i, i + 1024), leg.audio, HOST);
            if ((i / 1024) % 4 === 3) await sleep(10);
          }
          await sleep(50);
          if (child.exitCode === null) {
            child.exitCode = 0;
            cleanup();
            child.emit("exit", 0, null);
          }
        },
      };
    }
    return child;
  };
}

const quiet = { log: () => {}, error: (m) => console.log(m) };
const legs = [];
for (const leg of LEGS) {
  const packets = [];
  const heardOnKiss = [];
  const port = new SoundcardPort(
    {
      name: leg.name,
      device: "udp",
      playback: "udp",
      rate: RATE,
      modem: "1200",
      fec: leg.fec,
      tx: true,
      ptt: { kind: "none" },
      txDelayMs: 300,
      txTailMs: 50,
      persist: 255,
      slotTimeMs: 100,
      pttMaxMs: 10_000,
      txLevel: 0.25,
      dutyPct: 100,
    },
    { onPacket: (p) => packets.push(p) },
    { master: () => true, calls: [SITE], refusal: () => null },
    { ...quiet, spawn: udpSpawn(leg), siteCall: SITE },
  );
  await port.start();
  const kiss = new KissTnc(
    { host: HOST, port: leg.kiss, retryMs: 1000 },
    { onPacket: () => {}, onFrame: (f) => heardOnKiss.push(f) },
  );
  kiss.start();
  legs.push({ leg, port, kiss, packets, heardOnKiss });
}

const same = (a, b) => a.src === b.src && a.dst === b.dst && a.payload === b.payload;
for (const { leg, port, kiss, packets, heardOnKiss } of legs) {
  const label = leg.fec === "off" ? "AX.25" : leg.fec === "fx25" ? "FX.25" : "IL2P";
  // ---- soundcard port -> native Direwolf ----
  const up = { src: SITE, dst: TOCALL, path: ["WIDE1-1"], payload: `>soundcard ${leg.name} to direwolf ${run}` };
  const got = await until(45000, async () => {
    if (heardOnKiss.find((f) => same(f, up))) return true;
    if (port.send(up)) await until(8000, async () => heardOnKiss.find((f) => same(f, up)));
    return !!heardOnKiss.find((f) => same(f, up));
  });
  ok(
    `soundcard port (${label}) -> native Direwolf dw-sc-${leg.name}: frame intact`,
    !!got,
    `Direwolf decoded: ${JSON.stringify(heardOnKiss.map((f) => `${f.src}>${f.dst}:${f.payload}`))}`,
  );

  // ---- native Direwolf -> soundcard port ----
  const down = {
    src: "OE1DWS-7",
    dst: TOCALL,
    path: ["WIDE1-1", "WIDE2-1"],
    payload: `>direwolf ${leg.name} to soundcard ${run}`,
  };
  const heard = await until(45000, async () => {
    const p = packets.find((x) => same(x, down));
    if (p) return p;
    if (kiss.send(down)) await until(8000, async () => packets.find((x) => same(x, down)));
    return packets.find((x) => same(x, down)) ?? null;
  });
  ok(
    `native Direwolf dw-sc-${leg.name} (${label}) -> soundcard port: frame intact`,
    !!heard,
    `the port decoded: ${JSON.stringify(packets.map((p) => `${p.src}>${p.dst}:${p.payload}`))}`,
  );
  if (heard)
    ok(
      `the ${label} frame is a local RF hearing of the receiving site, as a plain one is`,
      heard.heardVia === "rf" && heard.port === "soundcard" && heard.igateCall === SITE,
      JSON.stringify({ heardVia: heard.heardVia, port: heard.port, igateCall: heard.igateCall }),
    );
}

for (const l of legs) await l.port.stop();
console.log(failures ? `\nSOUNDCARD DIREWOLF FAILED (${failures})` : "\nSOUNDCARD DIREWOLF PASSED");
process.exit(failures ? 1 : 0);
