// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime-neutral request handling: routing, CORS, JSON helper, and the scheduled job.
 * Imported by index.ts (Cloudflare Worker) and by the portable Node server — so both runtimes
 * serve byte-identical behaviour. This module never touches Workers-only globals.
 */
import type { Env } from "./env.js";
import type { ExecCtx } from "./runtime.js";
import { handleIngest } from "./ingest.js";
import {
  handleLog,
  handleCachesInBBox,
  handleCreateCache,
  handleCacheDetail,
  handleCacheLogs,
  handleUpdateCache,
} from "./caches.js";
import { handleSearch } from "./search.js";
import {
  handleClaim,
  handleSession,
  handleLogout,
  handleChangeCallsign,
  handleListCallsigns,
  handleAddCallsign,
  handlePasskeyRegisterBegin,
  handlePasskeyRegisterFinish,
  handlePasskeyLoginBegin,
  handlePasskeyLoginFinish,
} from "./auth.js";
import { handleEmailStart, handleEmailVerify } from "./email.js";
import { handleProfileUpdate } from "./profile.js";
import { handleWxSubmit, handleWxKey, handleWxTx } from "./wx.js";
import {
  handleMyStations,
  handleMyStation,
  handleStationWxKey,
  handleStationToCache,
  handleMeCache,
} from "./stations_mine.js";
import { startAprsChallenge, confirmAprsChallenge, aprsVerifyStatus } from "./callsign.js";
import { outboxPending, outboxAck } from "./outbox.js";
import {
  handleWellKnown,
  handleFederationCaches,
  handleFederationFinds,
  handleFederationKeys,
  handleFederationRegistry,
  serveFeed,
} from "./federation.js";
import { handleWellKnownSource, handleSourceRedirect, sourceInfo } from "./source.js";
import { handleSupport, handleSupportPage, handleSupportPrefs, handleSupportConfirm } from "./support.js";
import { handleSitemapXml, handleSitemapJson, handleSitemapPage, handleRobots } from "./sitemap.js";
import {
  handleActivityFeed,
  handleCachesFeed,
  handleBulletinsFeed,
  handleLeaderboardFeed,
  handleUserFeed,
} from "./feeds.js";
import { handleSpots } from "./spots.js";
import { handleApiV1 } from "./readapi.js";
import { handleEmbed, handleQr } from "./embed.js";
import { handleBoxEnqueue, handleBoxPoll, handleBoxAck, handleBoxLog } from "./box.js";
import { handleRelayEnqueue, handleRelayLease, handleRelayAnswer, handleRelayResult, relayPoll } from "./relay.js";
import { handleUserTx } from "./tx.js";
import { handleWatchList, handleWatchAdd, handleWatchRemove, handleWatchAlerts, handleWatchSeen } from "./watch.js";
import { handleViewCreate, handleViewList, handleViewDelete, handleViewResolve } from "./views.js";
import { handlePrefsGet, handlePrefsPut } from "./prefs.js";
import { handlePushKey, handlePushSubscribe, handlePushUnsubscribe, handleNotifyPrefs, runDigests } from "./notify.js";
import {
  handleFederationSync,
  handleFederationPeers,
  handlePeerTrust,
  handleFederationSubmit,
  syncAllPeers,
  pushToHub,
} from "./federation_sync.js";
import { handleAdminWhoami } from "./admin.js";
import { handleFederationTombstones } from "./tombstones.js";
import { handleFederationNotify, notifyPeers, isFederatedWrite } from "./gossip.js";
import { handleCorroborate } from "./corroborate.js";
import { handleRegisterKey, handleGetKeys } from "./keys.js";
import { handleImport } from "./import/engine.js";
import {
  handleLeaderboard,
  handleCorroborators,
  handleProfile,
  handleActivity,
  handleFavorite,
  handleWatch,
  handleRate,
} from "./community.js";
import {
  handleDecode,
  handleStations,
  handleStation,
  handleStationSeries,
  handleStationPackets,
  handlePorts,
  handleMessages,
} from "./workbench.js";
import { handleCot } from "./cot.js";
import { handleBadge } from "./badge.js";
import {
  handleSetStages,
  handleGetStages,
  handleUnlockStage,
  handleStageMedia,
  handleGetMedia,
  handleListCacheMedia,
  handleAddCacheMedia,
  handleDeleteCacheMedia,
} from "./stages.js";
import {
  handleAccountExport,
  handleAccountDelete,
  handleAccountBundle,
  handleAccountMove,
  handleAccountImport,
  handleFederationAccountMoves,
} from "./account.js";
import {
  handleBbsPost,
  handleBbsList,
  handleBbsBulletins,
  handleBbsRead,
  handleBbsSent,
  handleBbsThread,
  handleBbsSession,
  handleBbsKill,
  BULLETIN_FEED,
} from "./bbs.js";
import {
  handleBbsRoute,
  handleWhitePages,
  handleForwardRules,
  handleForwardRuleDelete,
  handleForwardPartners,
  handleForwardPartnerDelete,
  handleForwardPool,
  handleForwardInbound,
  handleForwardSent,
} from "./forward.js";
import { handleNodeNodes, handleNodeMheard } from "./node.js";
export { syncAllPeers } from "./federation_sync.js";

/** OPTIONS preflight + route + reflective CORS. The single entry both runtimes call. */
export async function handle(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), req, env);
  const res = await route(req, env, ctx);
  // gossip ping: a successful federated write coalesces into one "come pull" to our peers
  if (res.ok && isFederatedWrite(req.method, new URL(req.url).pathname))
    ctx.waitUntil(notifyPeers(env).catch(() => {}));
  return withCors(res, req, env);
}

/**
 * Frequent federation tasks: pull from peers, push to a hub, answer relay queries. Cheap +
 * safe to run every few minutes — the Worker's 15-minute cron calls THIS, not the full nightly job.
 */
export async function runFrequentSync(env: Env): Promise<void> {
  try {
    await syncAllPeers(env);
  } catch (e) {
    console.error("federation sync:", (e as Error).message);
  }
  try {
    await pushToHub(env);
  } catch (e) {
    console.error("push-to-hub:", (e as Error).message);
  }
  try {
    await relayPoll(env);
  } catch (e) {
    console.error("relay poll:", (e as Error).message);
  }
}

/**
 * The full nightly job: TTL-prune every always-growing table, then the federation sync and
 * the watch-alert digests. Node/Bun run this once at boot + daily; the Worker runs it on the `0 4` cron.
 */
export async function runScheduled(env: Env): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  // Prune in bounded batches (the rowid-subquery LIMIT works on D1, better-sqlite3 and
  // bun:sqlite alike) so a huge backlog never holds one long write transaction — on the synchronous
  // Node runtime a single mega-DELETE stalls every request until it finishes. 40 × 5000 caps one
  // nightly run at 200k rows; any remainder simply ages into the next night. Range-scanned via
  // idx_pos_source_ts (migration 0006).
  for (let i = 0; i < 40; i++) {
    const r = await env.DB.prepare(
      "DELETE FROM positions WHERE rowid IN (SELECT rowid FROM positions WHERE source IN ('firehose', 'browser-rf') AND ts < ? LIMIT 5000)",
    )
      .bind(nowS - 7 * 24 * 3600)
      .run();
    if ((r.meta?.changes ?? 0) < 5000) break;
  }
  // raw packet ring is a short-lived workbench diagnostic — prune hard (default 24h)
  const pktTtl = (Number(env.PACKETS_TTL_HOURS) || 24) * 3600;
  // Bound the other unbounded firehose/diagnostic tables too. Presence-critical logger data
  // (cache_logs, non-firehose positions) is untouched; these are all diagnostic/telemetry rings.
  const days = (n: number) => nowS - n * 24 * 3600;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM packets_recent WHERE ts < ?").bind(nowS - pktTtl),
    env.DB.prepare("DELETE FROM messages WHERE ts < ?").bind(days(Number(env.MESSAGES_TTL_DAYS) || 7)),
    env.DB.prepare("DELETE FROM sensor_readings WHERE ts < ?").bind(days(Number(env.SENSOR_TTL_DAYS) || 30)),
    env.DB.prepare("DELETE FROM port_stats WHERE ts < ?").bind(days(Number(env.PORTSTATS_TTL_DAYS) || 7)),
    env.DB.prepare("DELETE FROM watch_alerts WHERE ts < ? AND seen = 1").bind(days(Number(env.ALERTS_TTL_DAYS) || 30)),
    env.DB.prepare("DELETE FROM node_mheard WHERE last_heard < ?").bind(days(Number(env.MHEARD_TTL_DAYS) || 7)),
    env.DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(nowS * 1000), // expired windows
  ]);
  // Tombstones are retained INDEFINITELY. They are tiny and PII-free, but pruning them
  // resurrects GDPR deletes — a cursor reset, a new hub, or a submit replay would re-mirror the
  // erased record with nothing left to suppress it. Only the ephemeral relay queue is pruned.
  await env.DB.prepare("DELETE FROM fed_relay_queue WHERE created_at < ?")
    .bind(nowS - 3600)
    .run();
  await runFrequentSync(env);
  // email each account its un-notified watch alerts (no-op without an email provider)
  try {
    await runDigests(env);
  } catch (e) {
    console.error("digests:", (e as Error).message);
  }
}

/**
 * GET /health — readiness by default, liveness with `?live`.
 *
 * A gateway process can be up while its database is unreachable or unmigrated; an orchestrator that
 * only checks liveness would route traffic to it and every request would then fail. So the default
 * probe pings the DB and reports 503 (`db: "down"`) until it answers — traffic is held until the
 * instance is genuinely ready. `?live` skips the DB for cheap load-balancer polling (process-up only).
 * The body carries the instance id + running source commit for at-a-glance ops visibility (no secrets).
 */
async function handleHealth(req: Request, env: Env): Promise<Response> {
  if (new URL(req.url).searchParams.has("live")) return json({ ok: true, live: true });
  let db: "up" | "down" = "up";
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
  } catch {
    db = "down";
  }
  const { commit } = sourceInfo(env);
  return json(
    { ok: db === "up", db, instance: env.INSTANCE ?? null, commit: commit ?? null },
    { status: db === "up" ? 200 : 503 },
  );
}

export async function route(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname,
    m = req.method;

  if (p === "/health") return handleHealth(req, env);

  // AGPL §13 source link — the source this instance is running
  if (p === "/.well-known/source" && m === "GET") return handleWellKnownSource(req, env);
  if (p === "/source" && m === "GET") return handleSourceRedirect(req, env);

  // supporter recognition + public transparency ledger — recognition only, gates nothing
  if (p === "/support" && m === "GET") return handleSupportPage(req, env);
  if (p === "/api/support" && m === "GET") return handleSupport(req, env);
  if (p === "/api/support/prefs" && (m === "GET" || m === "POST")) return handleSupportPrefs(req, env);
  if (p === "/api/support/confirm" && m === "POST") return handleSupportConfirm(req, env);

  // site map + RSS feeds — machine-readable map of the app + feeds for crawlers/readers/tooling
  if (p === "/sitemap.xml" && m === "GET") return handleSitemapXml(req, env);
  if (p === "/sitemap" && m === "GET") return handleSitemapPage(req, env);
  if (p === "/api/sitemap" && m === "GET") return handleSitemapJson(req, env);
  if (p === "/robots.txt" && m === "GET") return handleRobots(req, env);
  if (p === "/feeds/activity.xml" && m === "GET") return handleActivityFeed(req, env);
  if (p === "/feeds/caches.xml" && m === "GET") return handleCachesFeed(req, env);
  if (p === "/feeds/bulletins.xml" && m === "GET") return handleBulletinsFeed(req, env);
  if (p === "/feeds/leaderboard.xml" && m === "GET") return handleLeaderboardFeed(req, env);
  const userFeed = /^\/feeds\/u\/([A-Za-z0-9-]+)\.xml$/.exec(p);
  if (userFeed && m === "GET") return handleUserFeed(req, env, userFeed[1]!);

  // live activity spots — read-only aggregation, edge/TTL-cached, off by default
  if (p === "/api/spots" && m === "GET") return handleSpots(req, env);

  // public read API — versioned, rate-limited, free keys; read-only
  if (p === "/api/v1" || p.startsWith("/api/v1/")) return handleApiV1(req, env, p.slice("/api/v1".length));

  // embeddable map widget + QR — public, CORS-open, read-only
  if (p === "/embed/qr.svg" && m === "GET") return handleQr(req, env);
  if (p === "/embed" && m === "GET") return handleEmbed(req, env);

  // save / share map views
  if (p === "/api/views" && m === "POST") return handleViewCreate(req, env);
  if (p === "/api/views" && m === "GET") return handleViewList(req, env);
  const viewDel = /^\/api\/views\/([a-z0-9]+)$/.exec(p);
  if (viewDel && m === "DELETE") return handleViewDelete(req, env, viewDel[1]!);
  const viewGet = /^\/v\/([a-z0-9]+)$/.exec(p);
  if (viewGet && m === "GET") return handleViewResolve(req, env, viewGet[1]!);

  // account-level UI preferences sync: theme, units/locale, pinned apps, basemap
  if (p === "/api/prefs" && m === "GET") return handlePrefsGet(req, env);
  if (p === "/api/prefs" && m === "PUT") return handlePrefsPut(req, env);

  // push + email-digest delivery — subscriptions + prefs; in-app alerts are the source
  if (p === "/api/push/key" && m === "GET") return handlePushKey(req, env);
  if (p === "/api/push/subscribe" && m === "POST") return handlePushSubscribe(req, env);
  if (p === "/api/push/unsubscribe" && m === "POST") return handlePushUnsubscribe(req, env);
  if (p === "/api/notify/prefs" && (m === "GET" || m === "POST")) return handleNotifyPrefs(req, env);

  // watchlist + alerts — session-scoped, per account
  if (p === "/api/watch" && m === "GET") return handleWatchList(req, env);
  if (p === "/api/watch" && m === "POST") return handleWatchAdd(req, env);
  if (p === "/api/watch/alerts" && m === "GET") return handleWatchAlerts(req, env);
  if (p === "/api/watch/seen" && m === "POST") return handleWatchSeen(req, env);
  const watchDel = /^\/api\/watch\/([A-Za-z0-9-]+)$/.exec(p);
  if (watchDel && m === "DELETE") return handleWatchRemove(req, env, watchDel[1]!);

  // remote control of the operator's own ingest box — gateway-as-relay
  const box = /^\/api\/box\/([A-Za-z0-9_.-]+)\/(command|commands|commands\/ack|log)$/.exec(p);
  if (box) {
    const [boxId, op] = [box[1]!, box[2]!];
    if (op === "command" && m === "POST") return handleBoxEnqueue(req, env, boxId);
    if (op === "commands" && m === "GET") return handleBoxPoll(req, env, boxId);
    if (op === "commands/ack" && m === "POST") return handleBoxAck(req, env, boxId);
    if (op === "log" && m === "GET") return handleBoxLog(req, env, boxId);
  }

  // federation rendezvous relay — a NAT'd spoke serves its feed via a hub, poll-based
  const relayQ = /^\/federation\/relay\/([A-Za-z0-9_.-]+)\/query$/.exec(p);
  if (relayQ && m === "POST") return handleRelayEnqueue(req, env, relayQ[1]!);
  const relayR = /^\/federation\/relay\/result\/(\d+)$/.exec(p);
  if (relayR && m === "GET") return handleRelayResult(req, env, relayR[1]!);
  if (p === "/federation/relay/lease" && m === "GET") return handleRelayLease(req, env);
  if (p === "/federation/relay/answer" && m === "POST") return handleRelayAnswer(req, env);

  // embeddable network badge (QRZ.com / signatures): /badge/OE8APR.svg
  const badgeMatch = /^\/badge\/([A-Za-z0-9-]+)\.svg$/.exec(p);
  if (badgeMatch && m === "GET") return handleBadge(req, env, badgeMatch[1]!);

  // federation: discovery + read-only signed feeds for mirroring
  if (p === "/.well-known/aprscaching" && m === "GET") return handleWellKnown(req, env);
  if (p === "/federation/caches" && m === "GET") return handleFederationCaches(req, env);
  if (p === "/federation/finds" && m === "GET") return handleFederationFinds(req, env);
  if (p === "/federation/bulletins" && m === "GET") return serveFeed(req, env, BULLETIN_FEED);
  if (p === "/api/admin/whoami" && m === "GET") return handleAdminWhoami(req, env);
  if (p === "/federation/peers" && m === "GET") return handleFederationPeers(req, env);
  if (p === "/federation/peers/trust" && m === "POST") return handlePeerTrust(req, env); // operator promote/block
  if (p === "/federation/sync" && m === "POST") return handleFederationSync(req, env);
  if (p === "/federation/corroborate" && m === "POST") return handleCorroborate(req, env);
  if (p === "/federation/keys" && m === "GET") return handleFederationKeys(req, env);
  if (p === "/federation/tombstones" && m === "GET") return handleFederationTombstones(req, env); // delete propagation
  if (p === "/federation/notify" && m === "POST") return handleFederationNotify(req, env, ctx); // gossip push-to-pull
  if (p === "/federation/submit" && m === "POST") return handleFederationSubmit(req, env); // push-to-hub (NAT/firewall peers)
  if (p === "/federation/account-moves" && m === "GET") return handleFederationAccountMoves(req, env); // account-move feed
  if (p === "/federation/registry" && m === "GET") return handleFederationRegistry(req, env); // signed instance registry

  // account data lifecycle (GDPR export/erasure + portability across peers)
  if (p === "/api/account/import" && m === "POST") return handleAccountImport(req, env);
  const acctMatch = /^\/api\/account\/([A-Za-z0-9-]+)\/(export|delete|bundle|move)$/.exec(p);
  if (acctMatch && m === "POST") {
    const [cs, op] = [acctMatch[1]!, acctMatch[2]!];
    if (op === "export") return handleAccountExport(req, env, cs);
    if (op === "delete") return handleAccountDelete(req, env, cs);
    if (op === "bundle") return handleAccountBundle(req, env, cs);
    if (op === "move") return handleAccountMove(req, env, cs);
  }

  // per-callsign device keys
  if (p === "/keys/register" && m === "POST") return handleRegisterKey(req, env);
  const keyMatch = /^\/keys\/([A-Za-z0-9-]+)$/.exec(p);
  if (keyMatch && m === "GET" && keyMatch[1] !== "register") return handleGetKeys(req, env, keyMatch[1]!);

  // ingest <-> worker
  if (p === "/ingest" && m === "POST") return handleIngest(req, env, ctx);
  if (p === "/outbox" && m === "GET") return outboxPending(req, env);
  if (p === "/outbox/ack" && m === "POST") return outboxAck(req, env);

  // live websocket -> region room
  if (p === "/ws") {
    const region = url.searchParams.get("region") ?? "global";
    return env.ROOMS.get(env.ROOMS.idFromName(region)).fetch(req);
  }

  // auth (passkey + email magic-link). Sessions attribute logs and gate announce.
  if (p === "/auth/claim" && m === "POST") return handleClaim(req, env);
  if (p === "/auth/passkey/register/begin" && m === "POST") return handlePasskeyRegisterBegin(req, env);
  if (p === "/auth/passkey/register/finish" && m === "POST") return handlePasskeyRegisterFinish(req, env);
  if (p === "/auth/passkey/login/begin" && m === "POST") return handlePasskeyLoginBegin(req, env);
  if (p === "/auth/passkey/login/finish" && m === "POST") return handlePasskeyLoginFinish(req, env);
  if (p === "/auth/email/start" && m === "POST") return handleEmailStart(req, env);
  if (p === "/auth/email/verify" && (m === "POST" || m === "GET")) return handleEmailVerify(req, env);
  if (p === "/auth/session" && m === "GET") return handleSession(req, env);
  if (p === "/auth/callsign" && m === "POST") return handleChangeCallsign(req, env);
  if (p === "/auth/profile" && m === "POST") return handleProfileUpdate(req, env);

  // weather user-origination — PWS push (Ecowitt / WU) under <call>-13
  if ((p === "/api/wx/submit" || p === "/api/wx/updateweatherstation") && (m === "GET" || m === "POST"))
    return handleWxSubmit(req, env);
  if (p === "/api/wx/key" && (m === "GET" || m === "POST")) return handleWxKey(req, env);
  if (p === "/api/wx/tx" && m === "POST") return handleWxTx(req, env);

  // operated-stations registry — manage your own stations (PWS / digi / igate / node)
  if (p === "/api/my/stations" && (m === "GET" || m === "POST")) return handleMyStations(req, env);
  if (p === "/api/me/cache" && m === "POST") return handleMeCache(req, env); // "become a cache" yourself
  const myStationMatch = /^\/api\/my\/stations\/(\d+)(\/wx-key|\/cache)?$/.exec(p);
  if (myStationMatch) {
    const sid = Number(myStationMatch[1]);
    if (myStationMatch[2] === "/wx-key") return handleStationWxKey(req, env, sid);
    if (myStationMatch[2] === "/cache" && m === "POST") return handleStationToCache(req, env, sid);
    if (!myStationMatch[2] && (m === "GET" || m === "PATCH" || m === "PUT" || m === "DELETE"))
      return handleMyStation(req, env, sid);
    return new Response("method not allowed", { status: 405 });
  }

  if (p === "/auth/callsigns" && m === "GET") return handleListCallsigns(req, env);
  if (p === "/auth/callsigns" && m === "POST") return handleAddCallsign(req, env);
  if (p === "/auth/logout" && m === "POST") return handleLogout();

  // async callsign-control verification badge
  if (p === "/verify/aprs/start" && m === "POST") return startAprsChallenge(req, env);
  if (p === "/verify/aprs/confirm" && m === "POST") return confirmAprsChallenge(req, env);
  if (p === "/verify/aprs/status" && m === "GET") return aprsVerifyStatus(req, env);

  // caching REST
  if (p === "/api/caches" && m === "GET") return handleCachesInBBox(req, env);
  if (p === "/api/caches" && m === "POST") return handleCreateCache(req, env);

  // enriched as-you-type search across caches + stations
  if (p === "/api/search" && m === "GET") return handleSearch(req, env);

  // community / gamification
  if (p === "/api/leaderboard" && m === "GET") return handleLeaderboard(req, env);
  if (p === "/api/corroborators" && m === "GET") return handleCorroborators(req, env);
  if (p === "/api/activity" && m === "GET") return handleActivity(req, env);
  const profileMatch = /^\/api\/profile\/([A-Za-z0-9-]+)$/.exec(p);
  if (profileMatch && m === "GET") return handleProfile(req, env, profileMatch[1]!);

  // workbench: packet inspector + live station registry
  if (p === "/api/decode" && m === "POST") return handleDecode(req);
  if (p === "/api/stations" && m === "GET") return handleStations(req, env);
  const seriesMatch = /^\/api\/stations\/([A-Za-z0-9-]+)\/series$/.exec(p);
  if (seriesMatch && m === "GET") return handleStationSeries(req, env, seriesMatch[1]!);
  const pktMatch = /^\/api\/stations\/([A-Za-z0-9-]+)\/packets$/.exec(p);
  if (pktMatch && m === "GET") return handleStationPackets(req, env, pktMatch[1]!);
  const stationMatch = /^\/api\/stations\/([A-Za-z0-9-]+)$/.exec(p);
  if (stationMatch && m === "GET") return handleStation(req, env, stationMatch[1]!);

  // BBS store-and-forward (messages + bulletins)
  if (p === "/api/bbs/messages" && m === "POST") return handleBbsPost(req, env);
  if (p === "/api/bbs/messages" && m === "GET") return handleBbsList(req, env);
  if (p === "/api/bbs/sent" && m === "GET") return handleBbsSent(req, env);
  if (p === "/api/bbs/bulletins" && m === "GET") return handleBbsBulletins(req, env);
  const bbsReadMatch = /^\/api\/bbs\/messages\/(\d+)\/read$/.exec(p);
  if (bbsReadMatch && m === "POST") return handleBbsRead(req, env, Number(bbsReadMatch[1]));
  const bbsThreadMatch = /^\/api\/bbs\/thread\/(\d+)$/.exec(p);
  if (bbsThreadMatch && m === "GET") return handleBbsThread(req, env, Number(bbsThreadMatch[1]));
  // forwarding + hierarchical routing + White Pages
  if (p === "/api/bbs/route" && m === "GET") return handleBbsRoute(req, env);
  if (p === "/api/bbs/wp" && (m === "GET" || m === "POST")) return handleWhitePages(req, env);
  if (p === "/api/bbs/forward" && (m === "GET" || m === "POST")) return handleForwardRules(req, env);
  const fwdDel = /^\/api\/bbs\/forward\/(\d+)$/.exec(p);
  if (fwdDel && m === "DELETE") return handleForwardRuleDelete(req, env, Number(fwdDel[1]));
  // FBB forwarding partners (per-partner transport config)
  if (p === "/api/bbs/partners" && (m === "GET" || m === "POST")) return handleForwardPartners(req, env);
  const partnerDel = /^\/api\/bbs\/partners\/(\d+)$/.exec(p);
  if (partnerDel && m === "DELETE") return handleForwardPartnerDelete(req, env, Number(partnerDel[1]));
  // forwarding pool (ingest scheduler ↔ gateway store; x-ingest-secret gated)
  // connected-mode BBS session snapshot + kill
  if (p === "/api/bbs/session" && m === "GET") return handleBbsSession(req, env);
  if (p === "/api/bbs/kill" && m === "POST") return handleBbsKill(req, env);
  if (p === "/api/bbs/forward/pool" && m === "GET") return handleForwardPool(req, env);
  if (p === "/api/bbs/forward/inbound" && m === "POST") return handleForwardInbound(req, env);
  if (p === "/api/bbs/forward/sent" && m === "POST") return handleForwardSent(req, env);
  // NET/ROM node: NODES table + MHeard + sysop admin
  if (p === "/api/node/nodes" && (m === "GET" || m === "POST")) return handleNodeNodes(req, env);
  if (p === "/api/node/mheard" && m === "GET") return handleNodeMheard(req, env);

  // workbench interop + transports
  if (p === "/api/cot" && m === "GET") return handleCot(req, env, Math.floor(Date.now() / 1000));
  if (p === "/api/ports" && m === "GET") return handlePorts(req, env);
  if (p === "/api/messages" && m === "GET") return handleMessages(req, env);
  if (p === "/api/tx/aprs" && m === "POST") return handleUserTx(req, env); // gated user TX via the ingest box

  // audio-cache: stages + media
  if (p.startsWith("/api/media/") && m === "GET") return handleGetMedia(req, env, p.slice("/api/media/".length));
  // cache media gallery: list (public) · add/delete (owner)
  const cacheMediaMatch = /^\/api\/caches\/(\d+)\/media$/.exec(p);
  if (cacheMediaMatch) {
    const id = Number(cacheMediaMatch[1]);
    if (m === "GET") return handleListCacheMedia(req, env, id);
    if (m === "POST") return handleAddCacheMedia(req, env, id);
  }
  const cacheMediaDel = /^\/api\/caches\/(\d+)\/media\/(\d+)$/.exec(p);
  if (cacheMediaDel && m === "DELETE")
    return handleDeleteCacheMedia(req, env, Number(cacheMediaDel[1]), Number(cacheMediaDel[2]));
  const stagesMatch = /^\/api\/caches\/(\d+)\/stages$/.exec(p);
  if (stagesMatch) {
    const id = Number(stagesMatch[1]);
    if (m === "GET") return handleGetStages(req, env, id);
    if (m === "POST") return handleSetStages(req, env, id);
  }
  const stageOpMatch = /^\/api\/caches\/(\d+)\/stages\/(\d+)\/(unlock|media)$/.exec(p);
  if (stageOpMatch) {
    const id = Number(stageOpMatch[1]),
      n = Number(stageOpMatch[2]);
    if (stageOpMatch[3] === "unlock" && m === "POST") return handleUnlockStage(req, env, id, n);
    if (stageOpMatch[3] === "media" && m === "PUT") return handleStageMedia(req, env, id, n);
  }

  // /api/caches/:id  and  /api/caches/:id/{logs,favorite,watch,rate}
  const cacheMatch = /^\/api\/caches\/(\d+)(\/logs|\/favorite|\/watch|\/rate)?$/.exec(p);
  if (cacheMatch) {
    const id = Number(cacheMatch[1]);
    const sub = cacheMatch[2];
    if (sub === "/logs" && m === "POST") return handleLog(req, env, id);
    if (sub === "/logs" && m === "GET") return handleCacheLogs(req, env, id);
    if (sub === "/favorite" && m === "POST") return handleFavorite(req, env, id);
    if (sub === "/watch" && m === "POST") return handleWatch(req, env, id);
    if (sub === "/rate" && m === "POST") return handleRate(req, env, id);
    if (!sub && m === "GET") return handleCacheDetail(req, env, id);
    if (!sub && (m === "PATCH" || m === "PUT")) return handleUpdateCache(req, env, id);
    return new Response("method not allowed", { status: 405 });
  }

  // generalized + back-compat logging (cacheId in body)
  if ((p === "/api/logs" || p === "/api/logs/find") && m === "POST") return handleLog(req, env);

  // import: POST /api/import/:source (admin)
  const importMatch = /^\/api\/import\/([a-z]+)$/.exec(p);
  if (importMatch && m === "POST") return handleImport(req, env, importMatch[1]!);

  return new Response("not found", { status: 404 });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** XML/RSS/text responses (sitemap, RSS feeds, robots.txt) — content-type defaults to XML. */
export function xml(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "application/xml; charset=utf-8", ...(init.headers ?? {}) },
  });
}

/** The origins allowed to make *credentialed* (cookie-bearing) cross-origin requests —
 *  APP_URL plus any CORS_ORIGINS. Empty (unconfigured instance) reflects all origins;
 *  a configured instance (production sets APP_URL) is locked down. */
function corsAllowlist(env: Env): Set<string> {
  const list = new Set<string>();
  const add = (u?: string) => {
    const s = u?.trim();
    if (!s) return;
    try {
      list.add(new URL(s).origin);
    } catch {
      /* ignore a malformed entry */
    }
  };
  add(env.APP_URL);
  for (const o of (env.CORS_ORIGINS ?? "").split(",")) add(o);
  return list;
}

/** CORS that reflects the request origin so the SPA (different origin) can call the API. Credentials
 *  are echoed only for allowlisted origins; other origins get non-credentialed access,
 *  enough for the public Bearer-keyed read API but not to ride a user's session cookie. */
export function withCors(res: Response, req: Request, env: Env): Response {
  const origin = req.headers.get("Origin");
  if (!origin) return res;
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", req.headers.get("Access-Control-Request-Headers") ?? "content-type");
  h.set("Access-Control-Max-Age", "86400");
  const allowed = corsAllowlist(env);
  if (allowed.size === 0 || allowed.has(origin)) h.set("Access-Control-Allow-Credentials", "true");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
