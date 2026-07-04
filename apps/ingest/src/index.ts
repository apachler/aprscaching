// SPDX-License-Identifier: AGPL-3.0-or-later
import { AprsIs } from "./aprsis.js";
import { KissTnc } from "./kiss.js";
import { CotListener } from "./cotlisten.js";
import { MeshtasticReader } from "./mesh.js";
import { Digipeater, ConnectedDigipeater } from "./digipeater.js";
import { Igate } from "./igate.js";
import { parseTNC2, classifyQ, parsePosition } from "@aprsweb/aprs";
import type { ParsedFrame } from "@aprsweb/aprs";
import { SessionServer, NodeSession } from "@aprsweb/packet";
import { parseAddr } from "@aprsweb/ax25";
import type { Packet } from "@aprsweb/shared";
import { loadDotEnv, numEnv, portEnv } from "./config.js";

loadDotEnv(); // `pnpm dev`/`start` run plain tsx/node — load a .env before reading env
const env = process.env;
const INGEST_URL = env.INGEST_URL ?? "http://127.0.0.1:8787/ingest";
const SECRET = env.INGEST_SECRET ?? "change-me";
const BATCH_MS = numEnv("BATCH_MS", 1500, { min: 100 }); // floor so a blank value can't tight-loop

const aprs = new AprsIs({
  host: env.APRSIS_HOST ?? "rotate.aprs2.net",
  port: portEnv("APRSIS_PORT", 14580),
  callsign: env.APRSIS_CALLSIGN ?? "N0CALL",
  passcode: env.APRSIS_PASSCODE ?? "-1",
  filter: env.APRSIS_FILTER ?? "r/47.07/15.42/300",
});

let batch: Packet[] = [];
const enqueue = (p: Packet) => batch.push(p);
let spool: Packet[] = []; // undelivered packets, retried next tick
const MAX_SPOOL = numEnv("INGEST_SPOOL_MAX", 5000, { min: 1 }); // bounded (drop-oldest) so a long outage can't OOM the Pi

// extra transports (opt-in via env) — all feed the same batch with their own `port`
if (env.KISS_TNC_HOST) {
  const frameSubs: ((f: ParsedFrame) => void)[] = [];
  const rawSubs: ((b: Uint8Array) => void)[] = [];
  const kiss = new KissTnc(
    { host: env.KISS_TNC_HOST, port: portEnv("KISS_TNC_PORT", 8001) },
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
  console.log("[kiss] enabled");

  // RF digipeater (KISS TX) — repeat n-N traffic
  if (env.DIGI_CALL) {
    const aliases = new Set(
      (env.DIGI_ALIASES ?? "WIDE1,WIDE2")
        .split(",")
        .map((a) => a.trim().toUpperCase())
        .filter(Boolean),
    );
    const digi = new Digipeater(kiss, { mycall: env.DIGI_CALL, aliases });
    frameSubs.push((f) => digi.onFrame(f));
    console.log(`[digi] enabled as ${env.DIGI_CALL} (${[...aliases].join(",")})`);

    // connected-mode digipeater — repeat SABM/I/… for NET/ROM + FBB relay through us
    if (env.DIGI_CONNECTED === "1") {
      const cdigi = new ConnectedDigipeater(kiss, {
        mycall: env.DIGI_CALL,
        aliases: [...aliases],
        viscousMs: env.DIGI_VISCOUS_MS ? Number(env.DIGI_VISCOUS_MS) : undefined,
      });
      rawSubs.push((b) => cdigi.onRaw(b));
      console.log(`[digi-c] connected-mode digipeater enabled as ${env.DIGI_CALL}`);
    }
  }

  // Connected-mode session server — answer inbound connects to our NET/ROM node and/or
  // BBS SSIDs. The NODE runs the NET/ROM CLI over the live routing table; the BBS runs the FBB command
  // interpreter over a per-caller gateway mail snapshot. NODE also broadcasts/consumes NODES over KISS.
  const gwBase = INGEST_URL.replace(/\/ingest$/, "");
  const services: import("@aprsweb/packet").Service[] = [];
  const users = new Set<string>();

  if (env.NETROM_CALL && env.NETROM_ALIAS) {
    const { NetromNodeRunner } = await import("./netromnode.js");
    const node = new NetromNodeRunner(kiss, {
      mycall: env.NETROM_CALL,
      alias: env.NETROM_ALIAS,
      broadcastMs: env.NETROM_BROADCAST_MS ? Number(env.NETROM_BROADCAST_MS) : undefined,
      pathQuality: env.NETROM_PATH_QUALITY ? Number(env.NETROM_PATH_QUALITY) : undefined,
      gatewayBase: gwBase,
      secret: SECRET,
    });
    rawSubs.push((b) => node.onRaw(b));
    node.start();
    const nodeApp = (r: import("@aprsweb/ax25").Ax25Address) =>
      new NodeSession(
        r.call,
        node.nodeStore(() => [...users]),
        env.NETROM_ALIAS!,
        env.NETROM_CALL!,
      );
    services.push({ addr: parseAddr(env.NETROM_CALL), name: "NODE", app: nodeApp, onConnect: node.connectThrough() });
    node.serveInbound(nodeApp); // also answer stations that connect a NET/ROM circuit TO us (L4 inbound)
    console.log(`[netrom] node CLI answering inbound connects on ${env.NETROM_CALL}`);
  }

  if (env.BBS_NODE_CALL) {
    const { gatewayBbsBackend } = await import("./forwarder.js");
    const { CachedBbsStore, BbsSession } = await import("@aprsweb/packet");
    const backend = gatewayBbsBackend(gwBase, SECRET);
    services.push({
      addr: parseAddr(env.BBS_NODE_CALL),
      name: "BBS",
      app: async (r) => {
        const store = new CachedBbsStore(r.call, backend);
        await store.refresh();
        return new BbsSession(r.call, store, env.BBS_NODE_CALL!);
      },
    });
    console.log(`[bbs] BBS answering inbound connects on ${env.BBS_NODE_CALL}`);
  }

  if (services.length) {
    const server = new SessionServer({
      send: (f) => {
        kiss.sendFrame(f);
      },
      services,
      onEvent: (e) => {
        if (e.kind === "connect") users.add(e.remote);
        else if (e.kind === "disconnect") users.delete(e.remote);
      },
    });
    rawSubs.push((b) => server.onRaw(b));
    setInterval(() => server.poll(), 1000);
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
    });
    frameSubs.push((f) => igate.onRf(f));
    igate.start();
    console.log(`[igate] enabled as ${env.IGATE_CALL}`);
  }
}
if (env.TAK_COT_PORT) {
  new CotListener({ port: portEnv("TAK_COT_PORT", 6969), bind: env.TAK_COT_BIND }, enqueue).start();
  console.log("[cot] enabled");
}
if (env.MESH_HOST) {
  new MeshtasticReader({ host: env.MESH_HOST, port: portEnv("MESH_PORT", 1883) }, enqueue).start();
  console.log("[mesh] enabled");
}
// AGWPE TNC — opt-in; any AGWPE modem (Direwolf/SoundModem/UZ7HO) feeds us over TCP.
if (env.AGWPE_HOST) {
  const { AgwpeTnc } = await import("./agwpe.js");
  new AgwpeTnc(
    { host: env.AGWPE_HOST, port: portEnv("AGWPE_PORT", 8000), radioPort: numEnv("AGWPE_RADIO_PORT", 0, { min: 0 }) },
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
    },
    { onPacket: enqueue },
  ).start();
  console.log("[hostmode] enabled");
}
// AXUDP tunnel — opt-in; tunnelled frames stay Tier C, never
// first-party RF. With AXUDP_PEERS it's a bidirectional KISS-equivalent port (carries NET/ROM
// crosslinks + FBB over the Internet leg); without, a plain RX-only listener.
if (env.AXUDP_PORT) {
  const opts = { port: portEnv("AXUDP_PORT", 10093), bind: env.AXUDP_BIND };
  if (env.AXUDP_PEERS) {
    const { AxudpPort, parseAxudpPeers } = await import("./axudp.js");
    const axPort = new AxudpPort({ ...opts, peers: parseAxudpPeers(env.AXUDP_PEERS) }, enqueue);
    axPort.start();
    console.log("[axudp] bidirectional port enabled (NET/ROM + FBB crosslink, Tier C)");
  } else {
    const { AxudpListener } = await import("./axudp.js");
    new AxudpListener(opts, enqueue).start();
    console.log("[axudp] listener enabled");
  }
}
// AXIP tunnel — AX.25 in raw IP proto 93 (vs AXUDP's UDP). Opt-in; needs a raw
// socket (CAP_NET_RAW) + the optional `raw-socket` package. Tunnelled frames stay Tier C, never first-party.
// With AXIP_PEERS it's a bidirectional port (RX + TX for NET/ROM + FBB crosslinks); without, RX-only.
if (env.AXIP_ENABLE || env.AXIP_PEERS) {
  if (env.AXIP_PEERS) {
    const { AxipPort, parseAxipPeers } = await import("./axip.js");
    await new AxipPort({ bind: env.AXIP_BIND, peers: parseAxipPeers(env.AXIP_PEERS) }, enqueue).start();
    console.log("[axip] bidirectional port enabled (NET/ROM + FBB crosslink, Tier C)");
  } else {
    const { AxipListener } = await import("./axip.js");
    await new AxipListener({ bind: env.AXIP_BIND }, enqueue).start();
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
// Opt-in: needs a KISS TNC + a station call. Partners + routing are configured in the gateway
// (Settings → Network); this box runs the sessions (ingest-locality). Off by default.
if (env.BBS_FORWARD === "1" && env.KISS_TNC_HOST && env.BBS_FORWARD_CALL) {
  const { startForwarder } = await import("./forwarder.js");
  startForwarder({
    base: INGEST_URL.replace(/\/ingest$/, ""),
    secret: SECRET,
    mycall: env.BBS_FORWARD_CALL,
    kiss: { host: env.KISS_TNC_HOST, port: portEnv("KISS_TNC_PORT", 8001) },
    pollMs: numEnv("BBS_FORWARD_POLL_MS", 60000, { min: 1000 }),
    sid: env.BBS_FORWARD_SID,
  });
  console.log(`[forward] FBB forwarding scheduler active as ${env.BBS_FORWARD_CALL}`);
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
