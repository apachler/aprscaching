import { AprsIs } from "./aprsis.js";
import { KissTnc } from "./kiss.js";
import { CotListener } from "./cotlisten.js";
import { MeshtasticReader } from "./mesh.js";
import { Digipeater } from "./digipeater.js";
import { Igate } from "./igate.js";
import { parseTNC2, classifyQ, parsePosition } from "@aprsweb/aprs";
import type { ParsedFrame } from "@aprsweb/aprs";
import type { Packet } from "@aprsweb/shared";

const env = process.env;
const INGEST_URL = env.INGEST_URL ?? "http://127.0.0.1:8787/ingest";
const SECRET = env.INGEST_SECRET ?? "change-me";
const BATCH_MS = Number(env.BATCH_MS ?? 1500);

const aprs = new AprsIs({
  host: env.APRSIS_HOST ?? "rotate.aprs2.net",
  port: Number(env.APRSIS_PORT ?? 14580),
  callsign: env.APRSIS_CALLSIGN ?? "N0CALL",
  passcode: env.APRSIS_PASSCODE ?? "-1",
  filter: env.APRSIS_FILTER ?? "r/47.07/15.42/300",
});

let batch: Packet[] = [];
const enqueue = (p: Packet) => batch.push(p);

// extra transports (opt-in via env) — all feed the same batch with their own `port`
if (env.KISS_TNC_HOST) {
  const frameSubs: ((f: ParsedFrame) => void)[] = [];
  const kiss = new KissTnc(
    { host: env.KISS_TNC_HOST, port: Number(env.KISS_TNC_PORT ?? 8001) },
    { onPacket: enqueue, onFrame: (f) => { for (const s of frameSubs) s(f); } },
  );
  kiss.start();
  console.log("[kiss] enabled");

  // RF digipeater (KISS TX) — repeat n-N traffic
  if (env.DIGI_CALL) {
    const aliases = new Set((env.DIGI_ALIASES ?? "WIDE1,WIDE2").split(",").map((a) => a.trim().toUpperCase()).filter(Boolean));
    const digi = new Digipeater(kiss, { mycall: env.DIGI_CALL, aliases });
    frameSubs.push((f) => digi.onFrame(f));
    console.log(`[digi] enabled as ${env.DIGI_CALL} (${[...aliases].join(",")})`);
  }
  // bidirectional APRS IGate (RF<->APRS-IS). Needs a real callsign + passcode.
  if (env.IGATE_CALL && env.IGATE_PASS) {
    const igate = new Igate(kiss, {
      host: env.APRSIS_HOST ?? "rotate.aprs2.net", port: Number(env.APRSIS_PORT ?? 14580),
      call: env.IGATE_CALL, pass: env.IGATE_PASS, filter: env.IGATE_FILTER,
      localTtlSec: env.IGATE_LOCAL_TTL ? Number(env.IGATE_LOCAL_TTL) : undefined,
    });
    frameSubs.push((f) => igate.onRf(f));
    igate.start();
    console.log(`[igate] enabled as ${env.IGATE_CALL}`);
  }
}
if (env.TAK_COT_PORT) {
  new CotListener({ port: Number(env.TAK_COT_PORT), bind: env.TAK_COT_BIND }, enqueue).start();
  console.log("[cot] enabled");
}
if (env.MESH_HOST) {
  new MeshtasticReader({ host: env.MESH_HOST, port: Number(env.MESH_PORT ?? 1883) }, enqueue).start();
  console.log("[mesh] enabled");
}
// AGWPE TNC (docs/27 B.1) — opt-in; any AGWPE modem (Direwolf/SoundModem/UZ7HO) feeds us over TCP.
if (env.AGWPE_HOST) {
  const { AgwpeTnc } = await import("./agwpe.js");
  new AgwpeTnc(
    { host: env.AGWPE_HOST, port: Number(env.AGWPE_PORT ?? 8000), radioPort: Number(env.AGWPE_RADIO_PORT ?? 0) },
    { onPacket: enqueue },
  ).start();
  console.log("[agwpe] enabled");
}
// WA8DED host-mode TNC (docs/27 B.1) — opt-in; a TF-firmware TNC / TFPCX over TCP (serial at deploy).
if (env.HOSTMODE_HOST) {
  const { HostmodeTnc } = await import("./hostmode.js");
  new HostmodeTnc(
    { host: env.HOSTMODE_HOST, port: Number(env.HOSTMODE_PORT ?? 3694), mycall: env.HOSTMODE_MYCALL, radioPort: Number(env.HOSTMODE_RADIO_PORT ?? 0) },
    { onPacket: enqueue },
  ).start();
  console.log("[hostmode] enabled");
}
// AXUDP tunnel (docs/22 reserved seam) — opt-in; tunnelled frames stay Tier C, never first-party RF.
if (env.AXUDP_PORT) {
  const { AxudpListener } = await import("./axudp.js");
  new AxudpListener({ port: Number(env.AXUDP_PORT), bind: env.AXUDP_BIND }, enqueue).start();
  console.log("[axudp] enabled");
}

aprs.on("up", () => console.log("[aprs-is] connected + filter sent"));
aprs.on("down", () => console.log("[aprs-is] disconnected, retrying..."));
aprs.on("line", (line: string) => {
  const f = parseTNC2(line);
  if (!f) return;
  const q = classifyQ(f.path);
  const pos = parsePosition(f.payload);
  const pkt: Packet = {
    src: f.src, dst: f.dst, path: f.path, payload: f.payload,
    kind: pos ? "position" : "other",
    parsed: pos ? (pos as unknown as Record<string, unknown>) : undefined,
    heardVia: q.heardVia, igateCall: q.igateCall,
    port: "aprs-is", ts: Math.floor(Date.now() / 1000), raw: f.raw,
  };
  batch.push(pkt);
});

setInterval(async () => {
  if (!batch.length) return;
  const packets = batch; batch = [];
  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
      body: JSON.stringify({ packets }),
    });
  } catch (e) { console.error("[forward] failed, dropping batch:", (e as Error).message); }
}, BATCH_MS);

aprs.start();
console.log(`[ingest] started -> ${INGEST_URL}`);

// ---- APRS-IS announce uplink: poll the Worker outbox and publish (opt-in finds) ----
import { AprsUplink } from "./uplink.js";
const SERVICE_CALL = env.APRSIS_SERVICE_CALL;
if (SERVICE_CALL && env.APRSIS_SERVICE_PASS) {
  const uplink = new AprsUplink({
    host: env.APRSIS_HOST ?? "rotate.aprs2.net",
    port: Number(env.APRSIS_PORT ?? 14580),
    serviceCall: SERVICE_CALL,
    servicePass: env.APRSIS_SERVICE_PASS,
  });
  uplink.start();
  // W3: an optional separate uplink to CWOP (feeds NOAA). Items with target='cwop' go here; when no
  // CWOP server is configured we fall back to standard APRS-IS, which also reaches CWOP-registered IDs.
  const cwop = env.CWOP_HOST
    ? new AprsUplink({ host: env.CWOP_HOST, port: Number(env.CWOP_PORT ?? 14580), serviceCall: SERVICE_CALL, servicePass: env.APRSIS_SERVICE_PASS })
    : null;
  cwop?.start();
  const base = INGEST_URL.replace(/\/ingest$/, "");
  setInterval(async () => {
    try {
      const r = await fetch(`${base}/outbox`, { headers: { "x-ingest-secret": SECRET } });
      const { items } = await r.json() as { items: any[] };
      const sent: number[] = [];
      for (const it of items ?? []) {
        const link = it.target === "cwop" && cwop ? cwop : uplink;   // W3 → CWOP, else standard APRS-IS
        if (link.publish(it)) sent.push(it.id);
      }
      if (sent.length) await fetch(`${base}/outbox/ack`, {
        method: "POST", headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
        body: JSON.stringify({ ids: sent }),
      });
    } catch { /* retry next tick */ }
  }, 4000);
  console.log("[uplink] announce + weather publisher active");
}
