// SPDX-License-Identifier: AGPL-3.0-or-later
import { AprsIs } from "./aprsis.js";
import { KissTnc } from "./kiss.js";
import { MeshcomListener, parseMeshcomNodes, parseMeshcomFanout } from "./meshcom.js";
import { Digipeater, ConnectedDigipeater } from "./digipeater.js";
import { Igate } from "./igate.js";
import { parseTNC2, classifyQ, parsePosition } from "@aprscaching/aprs";
import type { ParsedFrame } from "@aprscaching/aprs";
import { validateConfig, type Packet } from "@aprscaching/shared";
import { gatewayUrls, loadDotEnv, numEnv, portEnv } from "./config.js";
import { Delivery } from "./deliver.js";
import { txLimitFromEnv } from "./txlimit.js";
import { callWarnings } from "./callroles.js";
import { gatewayFetch, loadBoxKey, useBoxKey } from "./gatewayauth.js";
import type { BoxRadio, BoxState } from "./boxpoll.js";

loadDotEnv(); // `pnpm dev`/`start` run plain tsx/node — load a .env before reading env
const env = process.env;
// A malformed setting (a port that is not a number, an unknown on/off value) stops the start instead of
// falling back silently to a default the operator did not choose.
const CONFIG_PROBLEMS = validateConfig(env, "ingest");
if (CONFIG_PROBLEMS.length) {
  for (const p of CONFIG_PROBLEMS) console.error(`[ingest] FATAL: ${p.message}`);
  console.error("[ingest] See docs/reference/configuration.md for each setting's accepted values.");
  process.exit(1);
}
// An enrolled box signs its gateway requests with its own key; otherwise the shared secret is sent.
try {
  useBoxKey(loadBoxKey(env));
} catch (e) {
  console.error(`[ingest] FATAL: ${(e as Error).message}`);
  process.exit(1);
}
// INGEST_URL names the ingest endpoint; every other gateway route hangs off its base.
const { ingest: INGEST_URL, base: GATEWAY_BASE } = gatewayUrls(env.INGEST_URL);
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
// Undelivered packets wait here for the next flush, bounded (drop-oldest) so a long outage can't OOM the Pi.
const delivery = new Delivery({
  maxQueue: numEnv("INGEST_SPOOL_MAX", 5000, { min: 1 }),
  post: (packets) =>
    gatewayFetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
      body: JSON.stringify({ packets }),
    }),
});

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
  delivery.add(batch);
  batch = [];
  // A flush joins one already running; the deadline keeps a dead gateway from holding up the stop.
  const deadline = new Promise<void>((r) => setTimeout(r, 5000).unref());
  await Promise.race([delivery.flush(), deadline]);
  if (delivery.size) console.error(`[ingest] flush incomplete — dropping ${delivery.size} packet(s)`);
  else console.log("[ingest] pending packets flushed");
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
// stay null unless that function is configured. The KISS TNC (when present) is the remote-TX radio. Each
// transmitting function still needs its own opt-in (DIGI_CALL, IGATE_TX=1, BOX_TX=1) before `tx` matters.
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
// directly; the gateway attests it only when its sysop trusts the site.
const siteCall = env.RF_SITE_CALL || env.IGATE_CALL || undefined;

// extra transports (opt-in via env) — all feed the same batch with their own `port`
if (env.KISS_TNC_HOST) {
  const frameSubs: ((f: ParsedFrame) => void)[] = [];
  const rawSubs: ((b: Uint8Array) => void)[] = [];
  // RF_SITE_CALL (default: IGATE_CALL) names this box as the receiving site of what it hears directly,
  // so a gateway that trusts it attests those frames. This batch is the only way the
  // site's hearings reach Tier A: the RX-IGate's APRS-IS copy (`qAR,<site>`) is never attested.
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
        viscousMs: numEnv("DIGI_VISCOUS_MS", 0, { min: 0, max: 10_000 }) || undefined,
      });
      rawSubs.push((b) => {
        if (station.tx && station.digi) cdigi.onRaw(b);
      });
      console.log(`[digi-c] connected-mode digipeater enabled as ${env.DIGI_CALL}`);
    }
  }

  // APRS IGate (RF -> APRS-IS). Needs a real callsign + passcode. The APRS-IS -> RF direction transmits, so
  // it is a separate opt-in: IGATE_TX=1.
  if (env.IGATE_CALL && env.IGATE_PASS) {
    const igateTx = env.IGATE_TX === "1";
    const igate = new Igate(kiss, {
      host: env.APRSIS_HOST ?? "rotate.aprs2.net",
      port: portEnv("APRSIS_PORT", 14580),
      call: env.IGATE_CALL,
      pass: env.IGATE_PASS,
      filter: env.IGATE_FILTER,
      localTtlSec: numEnv("IGATE_LOCAL_TTL", 1800, { min: 60, max: 86_400 }),
      txPath: (env.IGATE_TX_PATH ?? "")
        .split(",")
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean),
      canTx: () => igateTx && station.tx && station.igate === true,
      ...txLimitFromEnv("igate"),
    });
    station.igate = true;
    frameSubs.push((f) => {
      if (station.igate) igate.onRf(f);
    });
    igate.start();
    console.log(
      `[igate] enabled as ${env.IGATE_CALL} (${igateTx ? "RF <-> APRS-IS" : "receive only; IGATE_TX=1 passes messages to RF"})`,
    );
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
/** The MeshCom node's KISS link, when its password is set, and the service call it passes acks for. */
let meshcomKiss: { link: import("./meshcom-kiss.js").MeshcomKiss; service: string | undefined } | null = null;
if (env.MESHCOM_NODE && env.MESHCOM_TX === "1") {
  const { MeshcomSender } = await import("./meshcom-send.js");
  const nodes = parseMeshcomNodes(env.MESHCOM_NODE);
  const operatorCall = env.MESHCOM_TX_CALL || env.BOX_CALL || env.IGATE_CALL || env.DIGI_CALL;
  const sender = new MeshcomSender({
    enabled: true,
    operatorCall,
    nodes,
    auditPath: env.MESHCOM_TX_AUDIT || undefined,
    ...txLimitFromEnv("meshcom"),
  });
  meshcomTx = { nodes, send: (req) => sender.send(req) };
  console.log(`[meshcom] transmit enabled as ${operatorCall ?? "? (set MESHCOM_TX_CALL)"}`);
  // the first node's KISS port, with its password: answers go out from the service call itself, and the
  // acks stations send it come back here
  const first = nodes.find((n) => n.call);
  if (env.MESHCOM_KISS_PASS && first?.call) {
    const { MeshcomKiss } = await import("./meshcom-kiss.js");
    const link = new MeshcomKiss(
      {
        host: first.ip,
        port: portEnv("MESHCOM_KISS_PORT", 8001),
        password: env.MESHCOM_KISS_PASS,
        nodeCall: first.call,
      },
      (from, msgNo) =>
        enqueue({
          src: from,
          dst: "APRS",
          path: [],
          payload: `:${(meshcomKiss?.service ?? "").padEnd(9)}:ack${msgNo}`,
          kind: "message",
          heardVia: "rf",
          port: "meshcom-kiss",
          ts: Math.floor(Date.now() / 1000),
        }),
    );
    link.start();
    meshcomKiss = { link, service: undefined };
    meshcomTx.kiss = {
      ip: first.ip,
      canSend: (from) => link.canSend(from),
      send: (from, info) => link.send(from, info),
    };
  }
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
    gwBase: GATEWAY_BASE,
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

setInterval(() => {
  if (shuttingDown) return;
  delivery.add(batch);
  batch = [];
  void delivery.flush(); // joins a flush still waiting on a slow gateway instead of posting the same packets twice
}, BATCH_MS);

aprs.start();

let uplinkWarned = false;
let uplinkStarted = false; // declared before the first learnServiceCall() can read it
const callWarned = new Set<string>();
// The gateway names its service call: the APRS-IS feed asks for messages addressed to it, and a station of
// this box sharing it would have its own commands ignored and, on MeshCom, acked by its own node.
async function learnServiceCall(): Promise<void> {
  try {
    const r = await gatewayFetch(`${INGEST_URL}/check`, { headers: { "x-ingest-secret": SECRET } });
    if (!r.ok) return;
    const { serviceCall, sites } = (await r.json()) as { serviceCall?: string; sites?: string[] };
    if (!serviceCall) return;
    aprs.setServiceCall(serviceCall);
    if (meshcomKiss) {
      meshcomKiss.service = serviceCall.toUpperCase();
      meshcomKiss.link.setServiceCall(serviceCall);
    }
    for (const w of callWarnings(env, serviceCall, sites))
      if (!callWarned.has(w)) {
        callWarned.add(w);
        console.error(`[ingest] ${w}`);
      }
    const login = uplinkLogin({
      serviceCall,
      explicitCall: env.APRSIS_SERVICE_CALL,
      explicitPass: env.APRSIS_SERVICE_PASS,
      feedCall: env.APRSIS_CALLSIGN,
      feedPass: env.APRSIS_PASSCODE,
    });
    if ("call" in login) {
      startUplink(login.call, login.pass);
      if (login.call.split("-")[0] !== serviceCall.toUpperCase().split("-")[0] && !uplinkWarned) {
        uplinkWarned = true;
        console.error(
          `[uplink] APRSIS_SERVICE_CALL ${login.call} is not a call of the service call's base; answers from ${serviceCall} go out as third-party traffic, which IGates do not gate to RF`,
        );
      }
    } else if (!uplinkStarted && !uplinkWarned) {
      uplinkWarned = true;
      console.log(`[uplink] not publishing to APRS-IS: ${login.reason}`);
    }
  } catch {
    /* the gateway is unreachable; the forwarder logs that, and the next attempt retries */
  }
}
void learnServiceCall();
setInterval(() => void learnServiceCall(), 15 * 60_000);
console.log(`[ingest] started -> ${INGEST_URL}`);

// ---- FBB forwarding scheduler — connect out to partner BBSes and exchange mail over RF.
// Opt-in: needs a frame link (KISS TNC or AXUDP port) + a station call. Partners + routing are
// configured in the gateway (Instance admin); this box runs the sessions (ingest-locality).
// The BBS forwards under its own call unless another is set: one packet BBS, one call.
const forwardCall = env.BBS_FORWARD_CALL || env.BBS_NODE_CALL;
if (env.BBS_FORWARD === "1" && forwardCall && (env.KISS_TNC_HOST || axudpPort)) {
  const { startForwarder } = await import("./forwarder.js");
  startForwarder({
    base: GATEWAY_BASE,
    secret: SECRET,
    mycall: forwardCall,
    kiss: env.KISS_TNC_HOST ? { host: env.KISS_TNC_HOST, port: portEnv("KISS_TNC_PORT", 8001) } : undefined,
    link: env.KISS_TNC_HOST ? undefined : axudpPort!,
    pollMs: numEnv("BBS_FORWARD_POLL_MS", 60000, { min: 1000 }),
    sid: env.BBS_FORWARD_SID,
    compress: env.BBS_FORWARD_COMPRESS === "1",
    ...txLimitFromEnv("bbs"),
  });
  console.log(`[forward] FBB forwarding scheduler active as ${forwardCall}`);
}

// ---- Remote control: lease commands the operator queued in the web app and execute them.
// Opt-in with BOX_ID; remote transmit additionally needs BOX_TX=1 and a command callsign that is this
// box's own station call (BOX_CALL, default IGATE_CALL or DIGI_CALL).
if (env.BOX_ID) {
  const { BoxPoller, parseBoxPath } = await import("./boxpoll.js");
  const boxCall = env.BOX_CALL || env.IGATE_CALL || env.DIGI_CALL;
  new BoxPoller({
    base: GATEWAY_BASE,
    secret: SECRET,
    boxId: env.BOX_ID,
    boxCall,
    remoteTx: env.BOX_TX === "1",
    radio: boxRadio,
    meshcom: meshcomTx,
    state: station,
    path: parseBoxPath(env.BOX_TX_PATH),
    maxAgeSec: numEnv("BOX_CMD_MAX_AGE", 900, { min: 30 }),
    pollMs: numEnv("BOX_POLL_MS", 5000, { min: 1000 }),
    ...txLimitFromEnv("box"),
  }).start();
  console.log(
    `[box] remote control active as ${env.BOX_ID} (remote transmit ${env.BOX_TX === "1" ? `allowed as ${boxCall ?? "?"}` : "disabled"})`,
  );
}

// ---- APRS-IS announce uplink: poll the Worker outbox and publish (opt-in finds) ----
import { AprsUplink, uplinkLogin } from "./uplink.js";
/**
 * Publish the gateway's outbox to APRS-IS: answers to radio commands, VERIFY replies, announced finds and
 * weather. Started once, under the login `uplinkLogin` chose.
 */
function startUplink(serviceCall: string, servicePass: string): void {
  if (uplinkStarted) return;
  uplinkStarted = true;
  const SERVICE_CALL = serviceCall;
  const uplink = new AprsUplink({
    host: env.APRSIS_HOST ?? "rotate.aprs2.net",
    port: portEnv("APRSIS_PORT", 14580),
    serviceCall: SERVICE_CALL,
    servicePass,
  });
  uplink.start();
  // CWOP relay: an optional separate uplink to CWOP (feeds NOAA). Items with target='cwop' go here; when no
  // CWOP server is configured we fall back to standard APRS-IS, which also reaches CWOP-registered IDs.
  const cwop = env.CWOP_HOST
    ? new AprsUplink({
        host: env.CWOP_HOST,
        port: portEnv("CWOP_PORT", 14580),
        serviceCall: SERVICE_CALL,
        servicePass,
      })
    : null;
  cwop?.start();
  const base = GATEWAY_BASE;
  let outboxFailing = false;
  let outboxLoggedAt = 0;
  let outboxPolling = false; // a poll still waiting on the gateway is not overlapped by the next one
  setInterval(async () => {
    if (outboxPolling) return;
    outboxPolling = true;
    try {
      const r = await gatewayFetch(`${base}/outbox`, { headers: { "x-ingest-secret": SECRET } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); // a 401/500 poll is a failure, not "no items"
      const { items } = (await r.json()) as { items: any[] };
      const sent: number[] = [];
      for (const it of items ?? []) {
        const link = it.target === "cwop" && cwop ? cwop : uplink; // target=cwop → CWOP relay, else standard APRS-IS
        if (link.publish(it)) sent.push(it.id);
      }
      if (sent.length)
        await gatewayFetch(`${base}/outbox/ack`, {
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
    } finally {
      outboxPolling = false;
    }
  }, 4000);
  console.log(`[uplink] publishing the gateway's outbox to APRS-IS as ${SERVICE_CALL}`);
}
// An explicit uplink starts at once; otherwise the box waits for the gateway to name its service call.
if (env.APRSIS_SERVICE_CALL && env.APRSIS_SERVICE_PASS) startUplink(env.APRSIS_SERVICE_CALL, env.APRSIS_SERVICE_PASS);
