// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import { ingestOrBoxOk } from "./auth.js";
import { readCappedBody } from "./fetchguard.js";
import { boxPrincipal } from "./boxprincipal.js";
import { siteAllowed } from "./boxkeys.js";
import type { Env } from "./env.js";
import type { ExecCtx, SqlStatement } from "./runtime.js";
import { json } from "./http.js";
import { IngestBatch, sanitizeMeshcomMeta } from "@aprscaching/shared";
import {
  meshcomGroupStatement,
  meshcomStatements,
  type MeshcomGroupHearing,
  type MeshcomObservation,
} from "./meshcom.js";
import { baseCall, decodeAprs, isValidLatLon, meshcomGroupOf } from "@aprscaching/aprs";
import { cachesNear, envelopeForPosition, dispatchLive, type LiveEnvelope } from "./live.js";
import { sendNearCacheMessages, nearOnAck, type NearFix } from "./nearradio.js";
import { recordWatchHeard } from "./watch.js";
import { recordRendezvous } from "./rendezvous.js";
import { recordMheard } from "./node.js";
import { verifySignedIngest } from "./keys.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { handleRadioMessage, splitMessageNumber, type RadioMessage } from "./radiolog.js";
import { serviceCall } from "./servicecall.js";
import { deliverMailbox, mailboxOnAck, type Heard } from "./mailbox.js";
import { transportForPort } from "./provenance.js";
import { attestation, sitesFor } from "./attestedsites.js";
import {
  downsamplePolicy,
  heardDirectly,
  lastStoredFixes,
  protectedStations,
  worthStoring,
  type StoredFix,
} from "./downsample.js";
import type { Transport } from "@aprscaching/shared";

/**
 * Position-bearing decoded data (position/object/item/weather with a fix). A fix outside ±90° / ±180°
 * or not a finite number is no fix, whether decoded here or pre-parsed by the ingest box.
 */
export function fixOf(p: { parsed?: unknown; dst?: string; path: string[]; payload: string; src: string }): {
  lat: number;
  lon: number;
  symbol?: string;
  course?: number;
  speedKn?: number;
  altitudeM?: number;
  comment?: string;
  /** the station's own position, not an object, item or weather report it sent */
  own: boolean;
} | null {
  const d = decodeAprs({ src: p.src, dst: p.dst ?? "", path: p.path, payload: p.payload, raw: "" }) as any;
  if (
    (d.kind === "position" || d.kind === "object" || d.kind === "item" || d.kind === "weather") &&
    isValidLatLon(d.lat, d.lon) &&
    d.lat !== 0
  ) {
    const sym = d.symbol ? `${d.symbol.table}${d.symbol.code}` : undefined;
    return {
      lat: d.lat,
      lon: d.lon,
      symbol: sym,
      course: d.course,
      speedKn: d.speedKn,
      altitudeM: d.altitudeM,
      comment: d.comment,
      own: d.kind === "position",
    };
  }
  // fall back to a pre-parsed {lat,lon,symbol} supplied by the ingest box, held to the same range
  const pp = p.parsed as any;
  if (pp?.lat != null && isValidLatLon(pp.lat, pp.lon))
    return { lat: pp.lat, lon: pp.lon, symbol: typeof pp.symbol === "string" ? pp.symbol : undefined, own: true };
  return null;
}

/** Body ceiling: INGEST_BATCH_MAX packets of a few hundred bytes fit comfortably in 5 MB. The body is read
 *  through a byte cap, so a larger one (declared or chunked) is refused without being buffered whole. */
const INGEST_BODY_MAX_BYTES = 5 * 1024 * 1024;

/**
 * GET /ingest/check — does this ingest credential work? 200 with the instance id, its service call (the box
 * asks APRS-IS for messages addressed to it) and, for an enrolled box's signed request, the box, for a valid
 * credential, 401 otherwise, with the receiving sites this credential's frames may claim (so the box can say
 * when its own site is not among them). It reads only that list and writes nothing, so a box (and
 * `deploy/aprscaching doctor`) can test its settings without posting a batch, draining the outbox or leasing
 * a command.
 */
export async function handleIngestCheck(req: Request, env: Env): Promise<Response> {
  if (!ingestOrBoxOk(req, env)) return json({ error: "invalid ingest credential" }, { status: 401 });
  const box = boxPrincipal(req)?.box ?? null;
  return json({
    ok: true,
    instance: env.INSTANCE ?? null,
    serviceCall: serviceCall(env),
    sites: [...sitesFor(await attestation(env), box)],
    box,
  });
}

/** Receive batched packets from the ingest box, persist positions, enrich the shack, fan out live. */
export async function handleIngest(req: Request, env: Env, _ctx: ExecCtx): Promise<Response> {
  const raw = await readCappedBody(req, INGEST_BODY_MAX_BYTES);
  if (!raw) return json({ error: "batch too large" }, { status: 413 });
  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // not JSON: refused as a bad batch below
  }
  const body = IngestBatch.safeParse(parsedBody);
  if (!body.success) return json({ error: "bad batch" }, { status: 400 });

  // Auth: the shared secret (trusted backend / self-host ingest), an enrolled box's signed request, OR a
  // signed browser batch: an operator's device key, registered to their callsign, signs the batch — so a
  // PUBLIC gateway accepts browser RF without handing out the shared secret. Signed batches are NOT trusted
  // to attribute an independent IGate, so their fixes are stored IGate-less and stay Tier C.
  const trusted = ingestOrBoxOk(req, env);
  let signer: { callsign: string } | null = null;
  if (!trusted) {
    signer = await verifySignedIngest(req, env, body.data.packets);
    if (!signer) return new Response("unauthorized", { status: 401 });
    if (await rateLimitedDurable(env, `ingest:${signer.callsign}`, Date.now(), 240, 60_000))
      return json({ error: "rate limited" }, { status: 429 });
  }
  // A signed batch authenticates ONE operator. On a PUBLIC gateway it may carry only that operator's
  // own traffic (any SSID of their base call) — otherwise a signed key would let anyone inject
  // positions/stations/messages/mheard attributed to arbitrary callsigns. Relaying third-party RF is
  // the trusted path's job (self-host ingest secret / apps/ingest), so foreign-src frames are dropped
  // from an untrusted batch rather than stored under a callsign the signer does not hold.
  const signerBase = signer ? baseCall(signer.callsign) : null;
  const packets = signerBase ? body.data.packets.filter((p) => baseCall(p.src) === signerBase) : body.data.packets;

  const stmts: SqlStatement[] = [];
  // every fix heard, for the live fan-out and the per-station hooks; `fixes` decides what is persisted
  const positions: {
    src: string;
    lat: number;
    lon: number;
    symbol?: string;
    course?: number;
    speedKn?: number;
    own: boolean;
    heard: Heard;
  }[] = [];
  const fixes: { p: (typeof packets)[number]; fix: NonNullable<ReturnType<typeof fixOf>>; transport: Transport }[] = [];
  const portRx = new Map<string, number>(); // RX packets per transport port, this batch
  const commands: RadioMessage[] = []; // messages to the service call — radio commands
  const service = serviceCall(env);
  const heard: Heard[] = []; // every station of the batch and its route, for the Mailbox
  const mailAcks: { from: string; msgNo: string; port: string }[] = []; // acks to the service call: Mailbox deliveries
  const meshcom: MeshcomObservation[] = []; // MeshCom node and link observations, display only
  const groupMessages: MeshcomGroupHearing[] = []; // MeshCom group chat, apart from the callsign message log
  let maxTs = 0;
  // Never trust a client timestamp verbatim. A future-dated fix would sit permanently
  // inside the verify window and an ancient one dodges the TTL — clamp every packet to
  // [now − 7 d, now + 60 s] before anything is persisted.
  const now = nowS();
  const clampTs = (t: number) => Math.min(Math.max(t, now - 7 * 24 * 3600), now + 60);
  // An enrolled box names only its own box id, and a box enrolled for a callsign only receiving sites of
  // that base call: a site or receiver of another call is dropped, never attested on its word.
  const principal = boxPrincipal(req);
  for (const p of packets) {
    p.ts = clampTs(p.ts);
    if (principal) {
      if (!siteAllowed(req, p.igateCall)) delete p.igateCall;
      if (!siteAllowed(req, p.rxCall)) delete p.rxCall;
      if (p.box && p.box !== principal.box) delete p.box;
    }
    portRx.set(p.port, (portRx.get(p.port) ?? 0) + 1);
    if (p.ts > maxTs) maxTs = p.ts;
    const data = decodeAprs({ src: p.src, dst: p.dst ?? "", path: p.path, payload: p.payload, raw: "" }) as any;

    // the route a Mailbox message takes back: the box only when the trusted ingest box heard it itself
    const route: Heard = {
      src: p.src,
      port: p.port,
      ...(trusted && p.box ? { box: p.box } : {}),
      ...(trusted && p.rxCall ? { rxCall: p.rxCall } : {}),
    };
    heard.push(route);

    // MeshCom metadata from the operator's own ingest only, sanitised again here: never from a signed batch
    if (trusted && p.port === "meshcom") {
      const meta = sanitizeMeshcomMeta((p.parsed as { meshcom?: unknown } | undefined)?.meshcom);
      if (meta) meshcom.push({ src: p.src, ts: p.ts, meta });
      const g = meshcomGroupOf(p.payload);
      if (g) groupMessages.push({ from: p.src, group: g.group, text: g.text, ts: p.ts, meta });
    }

    // weather -> sensor_readings (latest reading per station+ts)
    if (data.kind === "weather") {
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO sensor_readings (station, ts, temp_c, humidity, pressure_hpa, wind_dir, wind_kn, rain_mm)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).bind(
          p.src,
          p.ts,
          data.tempC ?? null,
          data.humidity ?? null,
          data.pressureHpa ?? null,
          data.windDirDeg ?? null,
          data.windKn ?? null,
          data.rain1hMm ?? null,
        ),
      );
    }
    if (data.kind === "message" && data.ack && data.msgNo && String(data.addressee ?? "").toUpperCase() === service)
      mailAcks.push({ from: p.src, msgNo: String(data.msgNo), port: p.port });
    // an ack for a message an operator sent from the app marks that message acknowledged
    if (data.kind === "message" && data.ack && data.msgNo && data.addressee)
      stmts.push(
        env.DB.prepare(
          "UPDATE messages SET acked_at = ? WHERE direction = 'tx' AND ack = ? AND from_call = ? AND to_call = ? AND acked_at IS NULL",
        ).bind(p.ts, String(data.msgNo), String(data.addressee).trim().toUpperCase(), p.src.toUpperCase()),
      );
    // text message -> messages log
    if (data.kind === "message" && !data.ack && !data.rej) {
      const toService = String(data.addressee ?? "").toUpperCase() === service;
      // the network that carried it, the same transport its sender's position would record
      const row = env.DB.prepare(
        "INSERT INTO messages (ts, from_call, to_call, body, ack, direction, transport) VALUES (?,?,?,?,?, 'rx', ?)",
      ).bind(
        p.ts,
        p.src,
        data.addressee ?? null,
        data.text ?? "",
        data.msgNo ?? null,
        transportForPort(p.port, signer != null),
      );
      stmts.push(row);
      if (toService) {
        const { text, msgNo } = splitMessageNumber(String(data.text ?? ""), data.msgNo);
        commands.push({
          src: p.src,
          text,
          ...(msgNo ? { msgNo } : {}),
          ts: p.ts,
          port: p.port,
          heardVia: p.heardVia,
          igateCall: p.igateCall ?? null,
          path: p.path,
          signed: signer != null,
          // routing hints come only from the trusted ingest box, never from a signed browser batch
          ...(trusted && p.box ? { box: p.box } : {}),
          ...(trusted && p.rxCall ? { rxCall: p.rxCall } : {}),
          ...(principal ? { deliveredBy: principal.box } : {}),
        });
      }
    }

    // shack raw packet view: a short, TTL-pruned ring of raw frames per
    // station — every heard packet, not only position fixes (status, telemetry, messages too).
    stmts.push(
      env.DB.prepare(
        "INSERT INTO packets_recent (callsign, ts, dst, path, payload, heard_via, port) VALUES (?,?,?,?,?,?,?)",
      ).bind(p.src, p.ts, p.dst ?? null, p.path.join(","), p.payload, p.heardVia, p.port),
    );

    const fix = fixOf(p);
    if (!fix) continue;
    positions.push({
      src: p.src,
      lat: fix.lat,
      lon: fix.lon,
      symbol: fix.symbol,
      course: fix.course,
      speedKn: fix.speedKn,
      own: fix.own,
      heard: route,
    });
    fixes.push({ p, fix, transport: transportForPort(p.port, signer != null) });
  }

  // Which fixes to persist: a directly heard RF fix and every fix of a protected station always; any
  // other fix once its station has moved or the interval has passed (downsample.ts). A fix that is not
  // stored still reaches the live map, watch alerts, rendezvous and BBS delivery below.
  // If the protection or last-fix read fails, every fix is stored: a lookup error never costs a fix.
  const policy = downsamplePolicy(env);
  let thinned = new Set<(typeof fixes)[number]>();
  let lastStored = new Map<string, StoredFix>();
  if (policy.enabled) {
    try {
      const thinnable = fixes.filter((f) => !heardDirectly(f.p.heardVia, f.transport));
      const calls = [...new Set(thinnable.map((f) => baseCall(f.p.src)))];
      const shielded = await protectedStations(env, calls, now);
      const open = thinnable.filter((f) => !shielded.has(baseCall(f.p.src)));
      lastStored = await lastStoredFixes(env, [...new Set(open.map((f) => f.p.src))]);
      thinned = new Set(open);
    } catch (e) {
      console.error("position storage lookup:", (e as Error).message);
      thinned = new Set();
    }
  }
  let persisted = 0;
  for (const f of fixes) {
    const { p, fix } = f;
    if (thinned.has(f) && !worthStoring(lastStored.get(p.src), { ...fix, ts: p.ts }, policy)) continue;
    lastStored.set(p.src, { lat: fix.lat, lon: fix.lon, ts: p.ts }); // later fixes in this batch compare with it
    persisted++;
    // A signed browser batch may NOT assert an independent IGate (no self-corroboration to Tier A),
    // so its fixes are stored IGate-less + tagged 'browser-rf'; trusted backends keep their IGate.
    const igate = trusted ? (p.igateCall ?? null) : null;
    const src = trusted ? "firehose" : "browser-rf";
    stmts.push(
      env.DB.prepare(
        `INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, speed_kn, altitude_m, course, transport, ingest_box)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        p.src,
        p.ts,
        fix.lat,
        fix.lon,
        p.heardVia,
        igate,
        p.path.join(","),
        src,
        fix.speedKn ?? null,
        fix.altitudeM ?? null,
        fix.course ?? null,
        f.transport,
        // the box that delivered it, from its verified signature: a site trusted through a box attests only these
        principal?.box ?? null,
      ),
    );
    // The station row in two statements, so a station that has not moved never rewrites its geo index:
    // the UPDATE refreshes an unmoved row without naming lat/lon, and the upsert inserts a new station or
    // moves one whose position changed (its WHERE skips an unmoved row). Exactly one of them writes.
    stmts.push(
      env.DB.prepare(
        `UPDATE stations SET last_seen = ?, symbol = ?, course = ?, speed_kn = ?, altitude_m = ?,
           comment = COALESCE(?, comment)
         WHERE callsign = ? AND lat IS ? AND lon IS ?`,
      ).bind(
        p.ts,
        fix.symbol ?? null,
        fix.course ?? null,
        fix.speedKn ?? null,
        fix.altitudeM ?? null,
        fix.comment ?? null,
        p.src,
        fix.lat,
        fix.lon,
      ),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO stations (callsign, lat, lon, last_seen, symbol, course, speed_kn, altitude_m, comment, source_call)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(callsign) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, last_seen=excluded.last_seen,
           symbol=excluded.symbol, course=excluded.course, speed_kn=excluded.speed_kn,
           altitude_m=excluded.altitude_m, comment=COALESCE(excluded.comment, stations.comment)
         WHERE stations.lat IS NOT excluded.lat OR stations.lon IS NOT excluded.lon`,
      ).bind(
        p.src,
        fix.lat,
        fix.lon,
        p.ts,
        fix.symbol ?? null,
        fix.course ?? null,
        fix.speedKn ?? null,
        fix.altitudeM ?? null,
        fix.comment ?? null,
        igate,
      ),
    );
    // Keep a registered operated-station's location live: if this callsign is in someone's registry,
    // an APRS position fix that moves it updates its stored coordinates (an unmoved one writes nothing).
    stmts.push(
      env.DB.prepare(
        "UPDATE account_stations SET lat = ?, lon = ?, updated_at = ? WHERE callsign = ? AND (lat IS NOT ? OR lon IS NOT ?)",
      ).bind(fix.lat, fix.lon, p.ts, p.src, fix.lat, fix.lon),
    );
  }
  // per-transport RX counters, bucketed by hour (port_stats)
  const bucket = Math.floor((maxTs || nowS()) / 3600) * 3600;
  for (const [port, rx] of portRx) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO port_stats (port, ts, rx, tx) VALUES (?,?,?,0)
         ON CONFLICT(port, ts) DO UPDATE SET rx = rx + excluded.rx`,
      ).bind(port, bucket, rx),
    );
  }
  // the MeshCom map layer's node state and links (display only), and its group chat
  stmts.push(...meshcomStatements(env, meshcom));
  for (const g of groupMessages) stmts.push(meshcomGroupStatement(env, g));
  if (stmts.length) await env.DB.batch(stmts);

  // radio commands (FOUND / DNF / NOTE / HELP) — best-effort per message; never fails the batch
  for (const c of commands) {
    try {
      await handleRadioMessage(env, c);
    } catch (e) {
      console.error("radio command:", (e as Error).message);
    }
  }

  // the Mailbox: confirm what was acked, then send what waits for the stations just heard (best-effort)
  try {
    for (const a of mailAcks) {
      await mailboxOnAck(env, a.from, a.msgNo, a.port);
      await nearOnAck(env, a.from, a.msgNo, a.port);
    }
    await deliverMailbox(env, heard);
  } catch (e) {
    console.error("mailbox:", (e as Error).message);
  }

  // raise watchlist alerts for any watched callsign just heard (best-effort; never blocks ingest)
  try {
    await recordWatchHeard(
      env,
      positions.map((p) => ({ src: p.src, lat: p.lat, lon: p.lon })),
    );
  } catch (e) {
    console.error("watch alerts:", (e as Error).message);
  }

  // record living-cache rendezvous for any opted-in living cache just heard (best-effort)
  try {
    await recordRendezvous(
      env,
      positions.map((p) => ({ src: p.src, lat: p.lat, lon: p.lon })),
    );
  } catch (e) {
    console.error("rendezvous:", (e as Error).message);
  }

  // per-port MHeard for the NET/ROM node (best-effort)
  try {
    await recordMheard(
      env,
      packets.map((p) => ({ src: p.src, port: p.port })),
    );
  } catch (e) {
    console.error("mheard:", (e as Error).message);
  }

  // live fan-out — station deltas + "you're near a cache" geofence prompts
  const envelopes: LiveEnvelope[] = [];
  const nearFixes: NearFix[] = [];
  for (const p of positions) {
    const near = await cachesNear(env, p.lat, p.lon);
    envelopes.push(await envelopeForPosition(env, p.src, p.lat, p.lon, p.symbol, p.course, near));
    if (near.length && p.own) nearFixes.push({ heard: p.heard, lat: p.lat, lon: p.lon, speedKn: p.speedKn, near });
  }
  await dispatchLive(env, envelopes);

  // the "you're near" radio message for opted-in players on foot near a cache (best-effort)
  if (nearFixes.length)
    try {
      await sendNearCacheMessages(env, nearFixes);
    } catch (e) {
      console.error("near-cache message:", (e as Error).message);
    }

  // `stored` counts the fixes accepted (live, watch, rendezvous); `persisted` those written to positions
  return json({ ok: true, stored: positions.length, persisted });
}
