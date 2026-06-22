import { AprsIs } from "./aprsis.js";
import { parseTNC2, classifyQ, parsePosition } from "@aprsweb/aprs";
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
  const base = INGEST_URL.replace(/\/ingest$/, "");
  setInterval(async () => {
    try {
      const r = await fetch(`${base}/outbox`, { headers: { "x-ingest-secret": SECRET } });
      const { items } = await r.json() as { items: any[] };
      const sent: number[] = [];
      for (const it of items ?? []) if (uplink.publish(it)) sent.push(it.id);
      if (sent.length) await fetch(`${base}/outbox/ack`, {
        method: "POST", headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
        body: JSON.stringify({ ids: sent }),
      });
    } catch { /* retry next tick */ }
  }, 4000);
  console.log("[uplink] announce publisher active");
}
