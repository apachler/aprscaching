// SPDX-License-Identifier: AGPL-3.0-or-later
import { AprsIs } from "./aprsis.js";
import { KissTnc } from "./kiss.js";
import { MeshcomListener, parseMeshcomNodes, parseMeshcomFanout } from "./meshcom.js";
import { Digipeater, ConnectedDigipeater } from "./digipeater.js";
import { Igate } from "./igate.js";
import { parseTNC2, classifyQ, parsePosition } from "@aprscaching/aprs";
import type { ParsedFrame } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { loadDotEnv, numEnv, portEnv } from "./config.js";
import type { BoxRadio, BoxState } from "./boxpoll.js";

loadDotEnv(); // `pnpm dev`/`start` run plain tsx/node — load a .env before reading env
const env = process.env;
const INGEST_URL = env.INGEST_URL ?? "http://127.0.0.1:8787/ingest";
const SECRET = env.INGEST_SECRET ?? "change-me";
const BATCH_MS = numEnv("BATCH_MS", 1500, { min: 100 }); // floor so a blank value can't tight-loop

// The ingest runs unattended 24/7 on the operator's box: one async bug in a parser or transport
// must not take down every transport at once. Log-and-continue mirrors servers/node — the batch
// loop and reconnecting transports are all independently self-healing.
process.on("unhandledRejection", (e) => {
  console.error("[ingest] unhandled rejection:", e instanceof Error ? (e.stack ?? e.message) : e);
});
process.on("uncaughtException", (e) => {
  console.error("[ingest] uncaught exception:", e.stack ?? e.message);
});
const aprs = new AprsIs({
  host: env.APRSIS_HOST ?? "rotate.aprs2.net",
  port: portEnv("APRSIS_PORT", 14580),
  callsign: env.APRSIS_CALLSIGN ?? "N0CALL",
  passcode: env.APRSIS_PASSCODE ?? "-1",
  filter: env.APRSIS_FILTER ?? "r/47.07/15.42/300",
});

let batch: Packet[] = [];
// Frames this box received over a radio it can also transmit on carry its BOX_ID, so the gateway can
// send an answer (an ack to a radio command) back through this box instead of over APRS-IS.
const RX_ANSWER_PORTS = new Set(["kiss-tnc", "meshcom"]);
const enqueue = (p: Packet) => {
  if (env.BOX_ID && RX_ANSWER_PORTS.has(p.port)) p.box = env.BOX_ID;
  batch.push(p);
};
let spool: Packet[] = []; // undelivered packets, retried next tick
const MAX_SPOOL = numEnv("INGEST_SPOOL_MAX", 5000, { min: 1 }); // bounded (drop-oldest) so a long outage can't OOM the Pi

// Graceful stop: best-effort flush of the pending batch + spool so a systemd/Docker restart or
// host shutdown loses as few heard packets as possible, then exit. Registered after the buffers
// exist so a signal during the async transport setup below can never hit an undeclared binding.
let shuttingDown = false;
const onShutdown: (() => void)[] = []; // transports that release a socket before exit
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const stop of onShutdown) stop();
  console.log(`[ingest] ${signal} — flushing pending packets…`);
  const packets = spool.concat(batch);
  batch = [];
  spool = [];
  if (packets.length) {
    try {
      await fetch(INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
        body: JSON.stringify({ packets }),
        signal: AbortSignal.timeout(3000),
      });
      console.log(`[ingest] flushed ${packets.length} packet(s)`);
    } catch {
      console.error(`[ingest] flush failed — dropping ${packets.length} packet(s)`);
    }
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// The connected-mode stack (NET/ROM node, session server, FBB forwarder) rides ONE frame link:
// the KISS TNC when the box has RF, else a bidirectional AXUDP port (BPQ/FBB crosslinks and the
// interop environment). Both satisfy the FrameLink seam; the engines never see the difference.
import type { FrameLink } from "./link.js";
let serviceLink: FrameLink | null = null;

// Runtime switches the remote-control poller flips. `tx` is the master RF transmit switch; digi/igate
// stay null unless that function is configured. The KISS TNC (when present) is the remote-TX radio.
const station: BoxState = { tx: true, digi: null, igate: null };
let boxRadio: BoxRadio | null = null;

// AXUDP tunnel — opt-in; tunnelled frames stay Tier C, never first-party RF. With AXUDP_PEERS it's
// a bidirectional KISS-equivalent port (carries NET/ROM crosslinks + FBB); without, RX-only.
let axudpPort: import("./axudp.js").AxudpPort | null = null;
if (env.AXUDP_PORT) {
  const opts = { port: portEnv("AXUDP_PORT", 10093), bind: env.AXUDP_BIND };
  if (env.AXUDP_PEERS) {
    const { AxudpPort, parseAxudpPeers } = await import("./axudp.js");
    axudpPort = new AxudpPort({ ...opts, peers: parseAxudpPeers(env.AXUDP_PEERS) }, enqueue);
    axudpPort.start();
    console.log("[axudp] bidirectional port enabled (NET/ROM + FBB crosslink, Tier C)");
  } else {
    const { AxudpListener } = await import("./axudp.js");
    new AxudpListener(opts, enqueue).start();
    console.log("[axudp] listener enabled");
  }
}

// The receiving-site call every local TNC (KISS, AGWPE, WA8DED host mode) stamps on frames it heard
// directly; the gateway attests it only when it is listed in FIRST_PARTY_SITES.
const siteCall = env.RF_SITE_CALL || env.IGATE_CALL || undefined;

// extra transports (opt-in via env) — all feed the same batch with their own `port`
if (env.KISS_TNC_HOST) {
  const frameSubs: ((f: ParsedFrame) => void)[] = [];
  const rawSubs: ((b: Uint8Array) => void)[] = [];
  // RF_SITE_CALL (default: IGATE_CALL) names this box as the receiving site of what it hears directly,
  // so a gateway that lists it in FIRST_PARTY_SITES can attest those frames without an APRS-IS round trip.
  const kiss = new KissTnc(
    { host: env.KISS_TNC_HOST, port: portEnv("KISS_TNC_PORT", 8001), siteCall },
    {
      onPacket: enqueue,
      onFrame: (f) => {
        for (const s of frameSubs) s(f);
      },
      onRaw: (b) => {
        for (const s of rawSubs) s(b);
      },
    },
  );
  kiss.start();
  console.log(`[kiss] enabled${siteCall ? ` — direct hearings name site ${siteCall.toUpperCase()}` : ""}`);
  boxRadio = kiss;
  serviceLink = {
    sendFrame: (f) => kiss.sendFrame(f),
    onRaw: (cb) => rawSubs.push(cb),
    offRaw: (cb) => {
      const i = rawSubs.indexOf(cb);
      if (i >= 0) rawSubs.splice(i, 1);
    },
  };

  // RF digipeater (KISS TX) — repeat n-N traffic
  if (env.DIGI_CALL) {
    const aliases = new Set(
      (env.DIGI_ALIASES ?? "WIDE1,WIDE2")
        .split(",")
        .map((a) => a.trim().toUpperCase())
        .filter(Boolean),
    );
    const digi = new Digipeater(kiss, { mycall: env.DIGI_CALL, aliases });
    station.digi = true;
    frameSubs.push((f) => {
      if (station.tx && station.digi) digi.onFrame(f);
    });
    console.log(`[digi] enabled as ${env.DIGI_CALL} (${[...aliases].join(",")})`);

    // connected-mode digipeater — repeat SABM/I/… for NET/ROM + FBB relay through us
    if (env.DIGI_CONNECTED === "1") {
      const cdigi = new ConnectedDigipeater(kiss, {
        mycall: env.DIGI_CALL,
        aliases: [...aliases],
        viscousMs: env.DIGI_VISCOUS_MS ? Number(env.DIGI_VISCOUS_MS) : undefined,
      });
      rawSubs.push((b) => {
        if (station.tx && station.digi) cdigi.onRaw(b);
      });
      console.log(`[digi-c] connected-mode digipeater enabled as ${env.DIGI_CALL}`);
    }
  }

  // bidirectional APRS IGate (RF<->APRS-IS). Needs a real callsign + passcode.
  if (env.IGATE_CALL && env.IGATE_PASS) {
    const igate = new Igate(kiss, {
      host: env.APRSIS_HOST ?? "rotate.aprs2.net",
      port: portEnv("APRSIS_PORT", 14580),
      call: env.IGATE_CALL,
      pass: env.IGATE_PASS,
      filter: env.IGATE_FILTER,
      localTtlSec: env.IGATE_LOCAL_TTL ? Number(env.IGATE_LOCAL_TTL) : undefined,
      canTx: () => station.tx && station.igate === true,
    });
    station.igate = true;
    frameSubs.push((f) => {
      if (station.igate) igate.onRf(f);
    });
    igate.start();
    console.log(`[igate] enabled as ${env.IGATE_CALL}`);
  }
}
// Meshtastic — licensed nodes only, from the node's protobuf TCP API (MESHTASTIC_HOST, port 4403) and/or
// the protobuf feed of an MQTT broker (MESHTASTIC_MQTT_URL). Both feeds share one licence registry, so a
// NodeInfo heard on either unlocks the node's positions on both.
if (env.MESHTASTIC_HOST || env.MESHTASTIC_MQTT_URL) {
  const { MeshtasticIngest, MeshtasticTcp, MeshtasticMqtt } = await import("./meshtastic.js");
  const mesh = new MeshtasticIngest(enqueue);
  if (env.MESHTASTIC_HOST) {
    new MeshtasticTcp({ host: env.MESHTASTIC_HOST, port: portEnv("MESHTASTIC_PORT", 4403) }, mesh).start();
    console.log(`[meshtastic] node TCP API ${env.MESHTASTIC_HOST}`);
  }
  if (env.MESHTASTIC_MQTT_URL) {
    new MeshtasticMqtt({ url: env.MESHTASTIC_MQTT_URL, topic: env.MESHTASTIC_MQTT_TOPIC || "msh/#" }, mesh).start();
    console.log("[meshtastic] MQTT protobuf feed enabled");
  }
}
// MeshCom — listener for nodes' ExtUDP interface. MESHCOM_NODE lists the allowed node addresses, each
// optionally with the node's callsign (`192.168.1.50=OE8APR-12`). MESHCOM_TX=1 additionally lets the box
// hand answers to radio commands to those nodes, under the operator's call (MESHCOM_TX_CALL).
let meshcomTx: import("./boxpoll.js").BoxMeshcom | null = null;
if (env.MESHCOM_NODE && env.MESHCOM_TX === "1") {
  const { MeshcomSender } = await import("./meshcom-send.js");
  const nodes = parseMeshcomNodes(env.MESHCOM_NODE);
  const operatorCall = env.MESHCOM_TX_CALL || env.BOX_CALL || env.IGATE_CALL || env.DIGI_CALL;
  const sender = new MeshcomSender({
    enabled: true,
    operatorCall,
    nodes,
    auditPath: env.MESHCOM_TX_AUDIT || undefined,
  });
  meshcomTx = { nodes, send: (req) => sender.send(req) };
  console.log(`[meshcom] transmit enabled as ${operatorCall ?? "? (set MESHCOM_TX_CALL)"}`);
}
if (env.MESHCOM_NODE) {
  const meshcom = new MeshcomListener(
    {
      nodes: parseMeshcomNodes(env.MESHCOM_NODE),
      port: portEnv("MESHCOM_PORT", 1799),
      bind: env.MESHCOM_BIND || undefined,
      fanout: parseMeshcomFanout(env.MESHCOM_FANOUT),
      ratePerSec: numEnv("MESHCOM_RATE", 20, { min: 1 }),
      staleMs: numEnv("MESHCOM_STALE_MIN", 30, { min: 1 }) * 60_000,
    },
    enqueue,
  );
  meshcom.start();
  onShutdown.push(() => meshcom.stop());
}
// AGWPE TNC — opt-in; any AGWPE modem (Direwolf/SoundModem/UZ7HO) feeds us over TCP.
if (env.AGWPE_HOST) {
  const { AgwpeTnc } = await import("./agwpe.js");
  new AgwpeTnc(
    {
      host: env.AGWPE_HOST,
      port: portEnv("AGWPE_PORT", 8000),
      radioPort: numEnv("AGWPE_RADIO_PORT", 0, { min: 0 }),
      siteCall,
    },
    { onPacket: enqueue },
  ).start();
  console.log("[agwpe] enabled");
}
// WA8DED host-mode TNC — opt-in; a TF-firmware TNC / TFPCX over TCP (serial at deploy).
if (env.HOSTMODE_HOST) {
  const { HostmodeTnc } = await import("./hostmode.js");
  new HostmodeTnc(
    {
      host: env.HOSTMODE_HOST,
      port: portEnv("HOSTMODE_PORT", 3694),
      mycall: env.HOSTMODE_MYCALL,
      radioPort: numEnv("HOSTMODE_RADIO_PORT", 0, { min: 0 }),
      siteCall,
    },
    { onPacket: enqueue },
  ).start();
  console.log("[hostmode] enabled");
}
// Connected-mode services — answer inbound connects to our NET/ROM node and/or BBS SSIDs over the
// service link (the KISS TNC when the box has RF, else the bidirectional AXUDP port). The NODE runs
// the NET/ROM CLI over the live routing table + broadcasts/consumes NODES; the BBS runs the FBB
// command interpreter over a per-caller gateway mail snapshot.
if (!serviceLink && axudpPort) serviceLink = axudpPort;
if (serviceLink) {
  const { startConnectedServices } = await import("./connected.js");
  await startConnectedServices({
    link: serviceLink,
    gwBase: INGEST_URL.replace(/\/ingest$/, ""),
    secret: SECRET,
    env,
  });
}
// AXIP tunnel — AX.25 in raw IP proto 93 (vs AXUDP's UDP). Opt-in; needs a raw
// socket (CAP_NET_RAW) + the optional `raw-socket` package. Tunnelled frames stay Tier C, never first-party.
// With AXIP_PEERS it's a bidirectional port (RX + TX for NET/ROM + FBB crosslinks); without, RX-only.
if (env.AXIP_ENABLE || env.AXIP_PEERS) {
  // AXIP is the one transport with an optional NATIVE dependency (`raw-socket`) — a missing/broken
  // install must degrade to "AXIP off", never stop APRS-IS and the other transports from starting.
  try {
    if (env.AXIP_PEERS) {
      const { AxipPort, parseAxipPeers } = await import("./axip.js");
      await new AxipPort({ bind: env.AXIP_BIND, peers: parseAxipPeers(env.AXIP_PEERS) }, enqueue).start();
      console.log("[axip] bidirectional port enabled (NET/ROM + FBB crosslink, Tier C)");
    } else {
      const { AxipListener } = await import("./axip.js");
      await new AxipListener({ bind: env.AXIP_BIND }, enqueue).start();
    }
  } catch (e) {
    console.error(`[axip] disabled — ${(e as Error).message} (needs the optional raw-socket package + CAP_NET_RAW)`);
  }
}

aprs.on("up", () => console.log("[aprs-is] connected + filter sent"));
aprs.on("down", () => console.log("[aprs-is] disconnected, retrying..."));
aprs.on("line", (line: string) => {
  const f = parseTNC2(line);
  if (!f) return;
  const q = classifyQ(f.path);
  const pos = parsePosition(f.payload);
  const pkt: Packet = {
    src: f.src,
    dst: f.dst,
    path: f.path,
    payload: f.payload,
    kind: pos ? "position" : "other",
    parsed: pos ? (pos as unknown as Record<string, unknown>) : undefined,
    heardVia: q.heardVia,
    igateCall: q.igateCall,
    port: "aprs-is",
    ts: Math.floor(Date.now() / 1000),
    raw: f.raw,
  };
  batch.push(pkt);
});

let spoolLoggedAt = 0;
setInterval(async () => {
  const packets = spool.concat(batch); // retry anything spooled from a prior failure, then the new batch
  batch = [];
  spool = [];
  if (!packets.length) return;
  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
      body: JSON.stringify({ packets }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // a 401/413/500 is NOT success
  } catch (e) {
    // keep the packets and retry next tick, bounded (drop-oldest) so an hours-long gateway
    // outage can't grow memory without limit. Rate-limit the log so a dead gateway can't flood the SD card.
    spool = packets.slice(-MAX_SPOOL);
    const nowMs = Date.now();
    if (nowMs - spoolLoggedAt > 30_000) {
      console.error(`[forward] gateway unreachable (${(e as Error).message}); spooled ${spool.length}/${MAX_SPOOL}`);
      spoolLoggedAt = nowMs;
    }
  }
}, BATCH_MS);

aprs.start();
console.log(`[ingest] started -> ${INGEST_URL}`);

// ---- FBB forwarding scheduler — connect out to partner BBSes and exchange mail over RF.
// Opt-in: needs a frame link (KISS TNC or AXUDP port) + a station call. Partners + routing are
// configured in the gateway (Settings → Network); this box runs the sessions (ingest-locality).
if (env.BBS_FORWARD === "1" && env.BBS_FORWARD_CALL && (env.KISS_TNC_HOST || axudpPort)) {
  const { startForwarder } = await import("./forwarder.js");
  startForwarder({
    base: INGEST_URL.replace(/\/ingest$/, ""),
    secret: SECRET,
    mycall: env.BBS_FORWARD_CALL,
    kiss: env.KISS_TNC_HOST ? { host: env.KISS_TNC_HOST, port: portEnv("KISS_TNC_PORT", 8001) } : undefined,
    link: env.KISS_TNC_HOST ? undefined : axudpPort!,
    pollMs: numEnv("BBS_FORWARD_POLL_MS", 60000, { min: 1000 }),
    sid: env.BBS_FORWARD_SID,
    compress: env.BBS_FORWARD_COMPRESS === "1",
  });
  console.log(`[forward] FBB forwarding scheduler active as ${env.BBS_FORWARD_CALL}`);
}

// ---- Remote control: lease commands the operator queued in the web app and execute them.
// Opt-in with BOX_ID; remote transmit additionally needs BOX_TX=1 and a command callsign that is this
// box's own station call (BOX_CALL, default IGATE_CALL or DIGI_CALL).
if (env.BOX_ID) {
  const { BoxPoller, parseBoxPath } = await import("./boxpoll.js");
  const boxCall = env.BOX_CALL || env.IGATE_CALL || env.DIGI_CALL;
  new BoxPoller({
    base: INGEST_URL.replace(/\/ingest$/, ""),
    secret: SECRET,
    boxId: env.BOX_ID,
    boxCall,
    remoteTx: env.BOX_TX === "1",
    radio: boxRadio,
    meshcom: meshcomTx,
    serviceCall: env.BOX_SERVICE_CALL || undefined,
    state: station,
    path: parseBoxPath(env.BOX_TX_PATH),
    maxAgeSec: numEnv("BOX_CMD_MAX_AGE", 900, { min: 30 }),
    pollMs: numEnv("BOX_POLL_MS", 5000, { min: 1000 }),
  }).start();
  console.log(
    `[box] remote control active as ${env.BOX_ID} (remote transmit ${env.BOX_TX === "1" ? `allowed as ${boxCall ?? "?"}` : "disabled"})`,
  );
}

// ---- APRS-IS announce uplink: poll the Worker outbox and publish (opt-in finds) ----
import { AprsUplink } from "./uplink.js";
const SERVICE_CALL = env.APRSIS_SERVICE_CALL;
if (SERVICE_CALL && env.APRSIS_SERVICE_PASS) {
  const uplink = new AprsUplink({
    host: env.APRSIS_HOST ?? "rotate.aprs2.net",
    port: portEnv("APRSIS_PORT", 14580),
    serviceCall: SERVICE_CALL,
    servicePass: env.APRSIS_SERVICE_PASS,
  });
  uplink.start();
  // CWOP relay: an optional separate uplink to CWOP (feeds NOAA). Items with target='cwop' go here; when no
  // CWOP server is configured we fall back to standard APRS-IS, which also reaches CWOP-registered IDs.
  const cwop = env.CWOP_HOST
    ? new AprsUplink({
        host: env.CWOP_HOST,
        port: portEnv("CWOP_PORT", 14580),
        serviceCall: SERVICE_CALL,
        servicePass: env.APRSIS_SERVICE_PASS,
      })
    : null;
  cwop?.start();
  const base = INGEST_URL.replace(/\/ingest$/, "");
  let outboxFailing = false;
  let outboxLoggedAt = 0;
  setInterval(async () => {
    try {
      const r = await fetch(`${base}/outbox`, { headers: { "x-ingest-secret": SECRET } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); // a 401/500 poll is a failure, not "no items"
      const { items } = (await r.json()) as { items: any[] };
      const sent: number[] = [];
      for (const it of items ?? []) {
        const link = it.target === "cwop" && cwop ? cwop : uplink; // target=cwop → CWOP relay, else standard APRS-IS
        if (link.publish(it)) sent.push(it.id);
      }
      if (sent.length)
        await fetch(`${base}/outbox/ack`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
          body: JSON.stringify({ ids: sent }),
        });
      if (outboxFailing) {
        console.log("[uplink] outbox poll recovered");
        outboxFailing = false;
      }
    } catch (e) {
      // don't swallow the failure forever — log once on transition + at most every 30 s,
      // so a broken outbox poll is visible without flooding the SD card.
      outboxFailing = true;
      const nowMs = Date.now();
      if (nowMs - outboxLoggedAt > 30_000) {
        console.error(`[uplink] outbox poll failed (${(e as Error).message}); retrying`);
        outboxLoggedAt = nowMs;
      }
    }
  }, 4000);
  console.log("[uplink] announce + weather publisher active");
}
