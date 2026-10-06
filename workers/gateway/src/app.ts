// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime-neutral request handling: routing, CORS, JSON helper, and the scheduled job.
 * Imported by the Node server and the Bun server — so both runtimes serve byte-identical behaviour.
 * This module touches no runtime-specific globals; each server supplies the bindings in `Env`.
 */
import { nowS } from "./util/time.js";
import { json } from "./http.js";
import { applyDerivedDefaults, type Env } from "./env.js";
import type { ExecCtx } from "./runtime.js";
import { POSITION_RETENTION_S, pruneBounded, pruneOperational, retentionFrom } from "./retention.js";
import { handleIngest, handleIngestCheck } from "./ingest.js";
import { handleTxGate } from "./txgate.js";
import {
  handleLog,
  handleCachesInBBox,
  handleCreateCache,
  handleCacheDetail,
  handleCacheLogs,
  handleUpdateCache,
  handleMyLogged,
  handleMyHides,
} from "./caches.js";
import { handleSearch } from "./search.js";
import {
  handleClaim,
  handleSession,
  handleLogout,
  handleLogoutAll,
  handleChangeCallsign,
  handleListCallsigns,
  handleAddCallsign,
  handlePasskeyRegisterBegin,
  handleListPasskeys,
  handleRemovePasskey,
  handlePasskeyRegisterFinish,
  handlePasskeyLoginBegin,
  handlePasskeyLoginFinish,
} from "./auth.js";
import {
  handleEmailChange,
  handleEmailResend,
  handleEmailStart,
  handleEmailVerify,
  handleOperatorLink,
} from "./email.js";
import { handleMyProfile, handleProfileUpdate } from "./profile.js";
import { handleWxSubmit, handleWxTx } from "./wx.js";
import {
  handleMyStations,
  handleMyStation,
  handleStationWxKey,
  handleStationToCache,
  handleMeCache,
  handleAdminAddStation,
} from "./stations_mine.js";
import { startAprsChallenge, aprsVerifyStatus, handleOperatorVerify } from "./callsign.js";
import {
  handleLicenceLookup,
  handleLicenceSources,
  handleLicenceImport,
  handleLicenceImportFinish,
} from "./licence.js";
import { startAmprChallenge, checkAmprChallenge } from "./verify_ampr.js";
import { startLotwChallenge, completeLotwChallenge, verifyMethods } from "./verify_lotw.js";
import { outboxPending, outboxAck } from "./outbox.js";
import { LIVE_REGION, liveRegionOf } from "./live.js";
import {
  handleWellKnown,
  handleFederationCaches,
  handleFederationFinds,
  handleFederationKeys,
  handleFederationRegistry,
  serveFeed,
} from "./federation.js";
import { handleWellKnownSource, handleSourceRedirect, sourceInfo } from "./source.js";
import { handleSecurityTxt } from "./securitytxt.js";
import { handleSupport, handleSupportPage, handleSupportPrefs, handleSupportConfirm } from "./support.js";
import { handleImprintPage, handlePrivacyPage } from "./legal.js";
import { handleSitemapXml, handleSitemapJson, handleSitemapPage, handleRobots } from "./sitemap.js";
import { extraOrigins, handleWebauthnOrigins, secureOrigin } from "./origins.js";
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
import {
  authenticateBox,
  boxMayActAs,
  handleCreateEnrollCode,
  handleEnroll,
  handleListBoxes,
  handleRevokeBox,
  handleTrustBox,
  handleBoxServices,
  handleBoxFinds,
} from "./boxkeys.js";
import { handleListSites, handleAddSite, handleRemoveSite, handleSiteFinds } from "./trustedsites.js";
import { handleBoxEnqueue, handleBoxPoll, handleBoxAck, handleBoxLog, handleBoxPair, handleBoxClaim } from "./box.js";
import {
  handleRelayEnqueue,
  handleRelayLease,
  handleRelayAnswer,
  handleRelayResult,
  handleRelayDispatch,
  relayPoll,
  purgeRelayQueue,
} from "./relay.js";
import { handleUserTx } from "./tx.js";
import { handleWatchList, handleWatchAdd, handleWatchRemove, handleWatchAlerts, handleWatchSeen } from "./watch.js";
import { handleViewCreate, handleViewList, handleViewDelete, handleViewResolve } from "./views.js";
import { handlePrefsGet, handlePrefsPut } from "./prefs.js";
import { handleAnnouncePrefs } from "./announce.js";
import {
  handlePushKey,
  handlePushSubscribe,
  handlePushUnsubscribe,
  handleNotifyPrefs,
  handleNotifyUnsubscribe,
  runDigests,
} from "./notify.js";
import { handleFederationSync, handlePeerSyncNow, syncAllPeers } from "./fedpull.js";
import { handleFederationPeers, handlePeerAdd, handlePeerRemove, handlePeerTrust } from "./fedpeers.js";
import { handleOfflinePack } from "./offlinepack.js";
import { TILES_PATH, handleOfflineTiles, handleTileArchive } from "./tiles.js";
import { handleSyncNow, handleSyncStatus } from "./fedcatchup.js";
import { handleFederationSubmit, handleSubmitMarks, pushSoon, pushToHub, type PushResult } from "./fedpush.js";
import {
  pruneMeshcom,
  handleMeshcomNodes,
  handleMeshcomLinks,
  handleMeshcomGroups,
  handleMeshcomGroupMessages,
} from "./meshcom.js";
import { collectRelayedCorroborations, retryCorroborations } from "./corroborate_retry.js";
import { handleAdminWhoami, handleAdminVerifications, handleAdminCallsigns } from "./admin.js";
import { handleClaimStart, handleClaimStatus } from "./claims.js";
import { handleMyApiKeys, handleRevokeMyApiKey, handleAdminApiKeys, handleAdminRevokeApiKey } from "./apikeys.js";
import { handleAdminSetup } from "./setup.js";
import { handleMailTest } from "./mail.js";
import { handleStationStatus } from "./station_status.js";
import { handleAdoptionList, handleCacheAdoption, handleAdminAdoptions } from "./adoption.js";
import { handleAdminModeration, handleReport } from "./moderation.js";
import { handleFederationTombstones } from "./tombstones.js";
import { handleFederationNotify, notifyPeers, isFederatedWrite } from "./gossip.js";
import { expireDiscovered, handlePeerExchange, handlePeerFollow } from "./feddiscover.js";
import { handleFed44netAdd } from "./fed44net.js";
import { handleIdentity } from "./fed44netcheck.js";
import { handleFedSync } from "./fedsync.js";
import { handleOriginSync, handleSyncSummary, purgeTransit } from "./fedtransit.js";
import { finishMediaDeletes } from "./mediadeletions.js";
import { handleGapsSeen } from "./fedgaps.js";
import { handleFedBbsEnqueue } from "./fedforward.js";
import { handleBeaconEmit, handleBeaconRx, handleFramesRx } from "./fedbeacon.js";
import { handlePacketPeers, handlePacketStatus } from "./fedpacket.js";
import { handleCorroborate } from "./corroborate.js";
import { handleRegisterKey, handleGetKeys } from "./keys.js";
import { handleImport, handleImportSources, handleImportedPlaces, handleRemoveImportedPlace } from "./import/engine.js";
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
  handleStations,
  handleStation,
  handleStationSeries,
  handleStationPackets,
  handlePorts,
  handleMessages,
  handleSentMessage,
} from "./shack.js";
import { handleCot, handleCotStream } from "./cot.js";
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
  handlePutMediaThumb,
} from "./stages.js";
import { handleAdminCachePlace } from "./cacheplace.js";
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
  BULLETIN_LIFETIME_SEC,
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
import { handleRadioCommandsList, handleRadioCommandDecision, expireRadioCommands } from "./radiolog.js";
import { handleMailboxPost, handleMailboxList, handleMailboxWithdraw, expireMailbox } from "./mailbox.js";
import { handleNearRadioPrefs, pruneNearCacheMessages } from "./nearradio.js";
import { runUpdateCheck } from "./updatecheck.js";
import { handleAdminSettings } from "./sitesettings.js";
import { handleAdminToolRegistries, handleMyToolRegistries, handleToolRegistries } from "./toolregistries.js";
import { loadSiteSettings } from "./siteconfig.js";
export { syncAllPeers } from "./fedpull.js";

export { isGatewayPath } from "./paths.js";

/**
 * OPTIONS preflight + route + reflective CORS. The single entry both runtimes call. It never throws: a failure
 * is logged here and answered with a generic JSON 500, so no runtime renders its own error page, stack trace or
 * error message to the client.
 */
export async function handle(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  try {
    return await handleRequest(req, env, ctx);
  } catch (e) {
    let path = "?";
    try {
      path = new URL(req.url).pathname;
    } catch {
      /* an unparsable URL: the path stays unknown */
    }
    console.error("%s %s:", req.method, path, e);
    try {
      return withCors(internalError(), req, env);
    } catch {
      return internalError();
    }
  }
}

/** The answer to a request that failed inside the gateway: nothing about the failure leaves the server. */
const internalError = (): Response => json({ error: "internal error" }, { status: 500 });

async function handleRequest(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  applyDerivedDefaults(env);
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), req, env);
  await loadSiteSettings(env);
  const res = await route(req, env, ctx);
  const path = new URL(req.url).pathname;
  // gossip ping: a successful federated write coalesces into one "come pull" to our peers
  if (res.ok && isFederatedWrite(req.method, path)) ctx.waitUntil(notifyPeers(env).catch(() => {}));
  // a spoke pushes to its hub a few seconds after a local write; a push with nothing new sends nothing
  if (res.ok && isLocalWrite(req.method, path)) pushSoon(env);
  return withCors(res, req, env);
}

/**
 * A request that may change a record the federation feeds carry: a member's or the sysop's write through
 * the API, a callsign key, a callsign verification. Ingest and federation traffic is not one: neither
 * creates a record this instance publishes.
 */
function isLocalWrite(method: string, path: string): boolean {
  return method !== "GET" && method !== "HEAD" && /^\/(?:api|keys|verify)\//.test(path);
}

/**
 * Frequent federation tasks: pull from peers, push to a hub, answer relay queries. Cheap +
 * safe to run every few minutes — the servers' frequent interval calls THIS, not the full nightly job.
 */
export function runFrequentSync(env: Env, opts: { resync?: boolean } = {}): Promise<FrequentSyncResult> {
  // one at a time: the interval, the reconnect probe and an operator's Sync now share the running one
  frequentSync ??= frequentSyncOnce(env, opts).finally(() => {
    frequentSync = null;
  });
  return frequentSync;
}
let frequentSync: Promise<FrequentSyncResult> | null = null;

/** What the frequent sync reports to the scheduler: the push-to-hub outcome (null without a hub). */
export interface FrequentSyncResult {
  push: PushResult | null;
}

async function frequentSyncOnce(env: Env, opts: { resync?: boolean }): Promise<FrequentSyncResult> {
  applyDerivedDefaults(env);
  await loadSiteSettings(env);
  let push: PushResult | null = null;
  try {
    await syncAllPeers(env);
  } catch (e) {
    console.error("federation sync:", (e as Error).message);
  }
  try {
    push = await pushToHub(env, undefined, { resync: opts.resync });
  } catch (e) {
    console.error("push-to-hub:", (e as Error).message);
  }
  try {
    await retryCorroborations(env);
  } catch (e) {
    console.error("corroboration retry:", (e as Error).message);
  }
  await runRelayTick(env);
  return { push };
}

/**
 * The relay's quick cadence (`FED_RELAY_POLL_MS`, 15 s, and every frequent sync): a spoke collects and
 * answers the queries its hub holds for it, and an asker reads the answers to corroboration questions it
 * left at a hub. Each half costs nothing without its configuration or a waiting question.
 */
export function runRelayTick(env: Env): Promise<void> {
  relayTick ??= relayTickOnce(env).finally(() => {
    relayTick = null;
  });
  return relayTick;
}
let relayTick: Promise<void> | null = null;

async function relayTickOnce(env: Env): Promise<void> {
  applyDerivedDefaults(env);
  try {
    await relayPoll(env);
  } catch (e) {
    console.error("relay poll:", (e as Error).message);
  }
  try {
    await collectRelayedCorroborations(env);
  } catch (e) {
    console.error("relayed corroboration:", (e as Error).message);
  }
}

/**
 * The full nightly job: TTL-prune every always-growing table, then the federation sync and
 * the watch-alert digests. Node and Bun run this once at boot and then daily.
 */
export async function runScheduled(env: Env): Promise<void> {
  applyDerivedDefaults(env);
  await loadSiteSettings(env);
  const now = nowS();
  // Prune in bounded batches (pruneBounded), range-scanned via idx_pos_source_ts.
  await pruneBounded(
    env,
    "positions",
    "SELECT rowid FROM positions WHERE source IN ('firehose', 'browser-rf') AND ts < ?",
    now - POSITION_RETENTION_S,
  );
  // Bound the other unbounded firehose/diagnostic tables too (see retention.ts). Presence-critical
  // logger data (cache_logs, non-firehose positions) is untouched; these are all diagnostic/telemetry rings.
  const keep = retentionFrom(env);
  const days = (n: number) => now - n * 24 * 3600;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM packets_recent WHERE ts < ?").bind(now - keep.packetsHours * 3600),
    env.DB.prepare("DELETE FROM messages WHERE ts < ?").bind(days(keep.messagesDays)),
    env.DB.prepare("DELETE FROM meshcom_group_messages WHERE ts < ?").bind(days(keep.messagesDays)),
    env.DB.prepare("DELETE FROM sensor_readings WHERE ts < ?").bind(days(keep.sensorDays)),
    env.DB.prepare("DELETE FROM port_stats WHERE ts < ?").bind(days(keep.portStatsDays)),
    env.DB.prepare("DELETE FROM watch_alerts WHERE ts < ? AND seen = 1").bind(days(keep.alertsDays)),
    env.DB.prepare("DELETE FROM node_mheard WHERE last_heard < ?").bind(days(keep.mheardDays)),
    env.DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(now * 1000), // expired windows
  ]);
  // radio commands nobody confirmed within the pending window expire
  await expireRadioCommands(env);
  await expireMailbox(env);
  await pruneNearCacheMessages(env);
  await pruneMeshcom(env, now);
  await pruneOperational(env, now, BULLETIN_LIFETIME_SEC);
  // Tombstones are retained INDEFINITELY. They are tiny and PII-free, but pruning them
  // resurrects GDPR deletes — a cursor reset, a new hub, or a submit replay would re-mirror the
  // erased record with nothing left to suppress it. Only the ephemeral relay queue is pruned.
  await purgeRelayQueue(env);
  // frames kept for passing on go with the records they carry; uploads an erasure or a removal left queued go
  await purgeTransit(env);
  await finishMediaDeletes(env);
  // discovered instances no trusted peer and no announcement names any more
  try {
    await expireDiscovered(env);
  } catch (e) {
    console.error("discovery expiry:", (e as Error).message);
  }
  await runFrequentSync(env);
  // the daily look for a newer release (off with UPDATE_CHECK=0); it never throws
  await runUpdateCheck(env);
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
 * The body carries the instance id, the running source commit and the newest applied migration (`schema`)
 * for at-a-glance ops visibility and for `deploy/aprscaching doctor`, which compares it with the checkout
 * (no secrets).
 */
/** The newest applied migration, as the migration runner records it in `_migrations`; null when unread. */
async function schemaVersion(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare("SELECT name FROM _migrations ORDER BY name DESC LIMIT 1").first<{
      name: string;
    }>();
    return row?.name ?? null;
  } catch {
    return null;
  }
}

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
    { ok: db === "up", db, instance: env.INSTANCE ?? null, commit: commit ?? null, schema: await schemaVersion(env) },
    { status: db === "up" ? 200 : 503 },
  );
}

export async function route(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname,
    m = req.method;
  // A box's signed request is verified here, once, before any handler reads the credential (boxkeys.ts).
  await authenticateBox(req, env);

  if (p === "/health") return handleHealth(req, env);

  // AGPL §13 source link — the source this instance is running
  if (p === "/.well-known/source" && m === "GET") return handleWellKnownSource(req, env);
  if (p === "/source" && m === "GET") return handleSourceRedirect(req, env);

  // RFC 9116 security contact (SECURITY_CONTACT, else OPERATOR_EMAIL)
  if (p === "/.well-known/security.txt" && m === "GET") return handleSecurityTxt(env);

  // WebAuthn related origins: the https addresses of this instance share RP_ID's passkeys
  if (p === "/.well-known/webauthn" && m === "GET") return handleWebauthnOrigins(env);

  // per-instance legal pages — the operator's imprint + privacy notice (OPERATOR_* env)
  if (p === "/imprint" && m === "GET") return handleImprintPage(env);
  if (p === "/privacy" && m === "GET") return handlePrivacyPage(env);

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
  if (p === "/api/announce" && (m === "GET" || m === "POST")) return handleAnnouncePrefs(req, env);
  if (p === "/api/near-radio" && (m === "GET" || m === "POST")) return handleNearRadioPrefs(req, env);
  if (p === "/api/prefs" && m === "GET") return handlePrefsGet(req, env);
  if (p === "/api/prefs" && m === "PUT") return handlePrefsPut(req, env);

  // push + email-digest delivery — subscriptions + prefs; in-app alerts are the source
  if (p === "/api/push/key" && m === "GET") return handlePushKey(req, env);
  if (p === "/api/push/subscribe" && m === "POST") return handlePushSubscribe(req, env);
  if (p === "/api/push/unsubscribe" && m === "POST") return handlePushUnsubscribe(req, env);
  if (p === "/api/notify/prefs" && (m === "GET" || m === "POST")) return handleNotifyPrefs(req, env);
  if (p === "/api/notify/unsubscribe" && (m === "GET" || m === "POST")) return handleNotifyUnsubscribe(req, env);

  // watchlist + alerts — session-scoped, per account
  if (p === "/api/watch" && m === "GET") return handleWatchList(req, env);
  if (p === "/api/watch" && m === "POST") return handleWatchAdd(req, env);
  if (p === "/api/watch/alerts" && m === "GET") return handleWatchAlerts(req, env);
  if (p === "/api/watch/seen" && m === "POST") return handleWatchSeen(req, env);
  const watchDel = /^\/api\/watch\/([A-Za-z0-9-]+)$/.exec(p);
  if (watchDel && m === "DELETE") return handleWatchRemove(req, env, watchDel[1]!);

  // remote control of the operator's own ingest box — gateway-as-relay
  const box = /^\/api\/box\/([A-Za-z0-9_.-]+)\/(command|commands|commands\/ack|log|pair|claim)$/.exec(p);
  if (box) {
    const [boxId, op] = [box[1]!, box[2]!];
    // an enrolled box signs only for itself; the shared secret and the operator act for any box
    if (!boxMayActAs(req, boxId))
      return json({ error: "this box's key does not act for another box" }, { status: 403 });
    if (op === "command" && m === "POST") return handleBoxEnqueue(req, env, boxId);
    if (op === "commands" && m === "GET") return handleBoxPoll(req, env, boxId);
    if (op === "commands/ack" && m === "POST") return handleBoxAck(req, env, boxId);
    if (op === "log" && m === "GET") return handleBoxLog(req, env, boxId);
    if (op === "pair" && m === "POST") return handleBoxPair(req, env, boxId);
    if (op === "claim" && m === "POST") return handleBoxClaim(req, env, boxId);
  }

  // federation rendezvous relay — a NAT'd spoke serves its feed via a hub, poll-based
  const relayQ = /^\/federation\/relay\/([A-Za-z0-9_.-]+)\/query$/.exec(p);
  if (relayQ && m === "POST") return handleRelayEnqueue(req, env, relayQ[1]!);
  const relayR = /^\/federation\/relay\/result\/(\d+)$/.exec(p);
  if (relayR && m === "GET") return handleRelayResult(req, env, relayR[1]!);
  if (p === "/federation/relay/lease" && m === "GET") return handleRelayLease(req, env);
  if (p === "/federation/relay/answer" && m === "POST") return handleRelayAnswer(req, env);
  // packet leg: pack a spoke's queued queries into an ACSFED batch, personal mail to FBB partners (sysop/operator secret)
  const relayD = /^\/federation\/relay\/([A-Za-z0-9_.-]+)\/dispatch$/.exec(p);
  if (relayD && m === "POST") return handleRelayDispatch(req, env, relayD[1]!);

  // embeddable network badge (QRZ.com / signatures): /badge/OE8APR.svg
  const badgeMatch = /^\/badge\/([A-Za-z0-9-]+)\.svg$/.exec(p);
  if (badgeMatch && m === "GET") return handleBadge(req, env, badgeMatch[1]!);

  // federation: discovery + read-only signed feeds for mirroring
  if (p === "/.well-known/aprscaching" && m === "GET") return handleWellKnown(req, env);
  if (p === "/federation/caches" && m === "GET") return handleFederationCaches(req, env);
  if (p === "/federation/finds" && m === "GET") return handleFederationFinds(req, env);
  if (p === "/federation/bulletins" && m === "GET") return serveFeed(req, env, BULLETIN_FEED);
  if (p === "/api/admin/whoami" && m === "GET") return handleAdminWhoami(req, env);
  if (p === "/api/admin/setup" && m === "GET") return handleAdminSetup(req, env);
  if (p === "/api/admin/settings") return handleAdminSettings(req, env);
  const settingKey = /^\/api\/admin\/settings\/([A-Za-z0-9_]{1,64})$/.exec(p);
  if (settingKey) return handleAdminSettings(req, env, settingKey[1]);
  // tool registries: the effective list and the carrier, the sysop's list, and a player's own
  if (p === "/api/tools/registries" || p.startsWith("/api/tools/registries/"))
    return handleToolRegistries(req, env, p.slice("/api/tools/registries".length));
  if (p === "/api/admin/tool-registries" || p.startsWith("/api/admin/tool-registries/"))
    return handleAdminToolRegistries(req, env, p.slice("/api/admin/tool-registries".length));
  if (p === "/api/my/tool-registries" || p.startsWith("/api/my/tool-registries/"))
    return handleMyToolRegistries(req, env, p.slice("/api/my/tool-registries".length));
  if (p === "/api/admin/mail-test" && m === "POST") return handleMailTest(req, env);
  if (p === "/api/admin/station-status" && m === "GET") return handleStationStatus(req, env);
  if (p === "/api/admin/federation/identity" && m === "GET") return handleIdentity(req, env); // records to publish; ?check=1 runs the read-only DNS self-check
  if (p === "/api/admin/verifications") return handleAdminVerifications(req, env);
  const adminVerif = /^\/api\/admin\/verifications\/([A-Za-z0-9-]{3,12})$/.exec(p);
  if (adminVerif) return handleAdminVerifications(req, env, adminVerif[1]);
  const adminCall = /^\/api\/admin\/callsigns\/([A-Za-z0-9-]{3,12})$/.exec(p);
  if (adminCall) return handleAdminCallsigns(req, env, adminCall[1]!);
  if (p === "/api/admin/adoptions") return handleAdminAdoptions(req, env);
  if (p === "/api/admin/api-keys" && m === "GET") return handleAdminApiKeys(req, env);
  const adminKey = /^\/api\/admin\/api-keys\/(\d+)$/.exec(p);
  if (adminKey && m === "DELETE") return handleAdminRevokeApiKey(req, env, Number(adminKey[1]));
  if (p === "/api/keys") return handleMyApiKeys(req, env);
  const myKey = /^\/api\/keys\/(\d+)$/.exec(p);
  if (myKey && m === "DELETE") return handleRevokeMyApiKey(req, env, Number(myKey[1]));
  // moderation: reports, takedowns, suspensions and the audit log (sysop-only), and filing a report
  if (p.startsWith("/api/admin/moderation/"))
    return handleAdminModeration(req, env, p.slice("/api/admin/moderation".length));
  if (p === "/api/reports" && m === "POST") return handleReport(req, env);
  const adminAdopt = /^\/api\/admin\/adoptions\/(\d+)(\/assign)?$/.exec(p);
  if (adminAdopt) return handleAdminAdoptions(req, env, { cacheId: Number(adminAdopt[1]), assign: !!adminAdopt[2] });
  const adminPlace = /^\/api\/admin\/caches\/(\d+)\/place$/.exec(p);
  if (adminPlace && m === "POST") return handleAdminCachePlace(req, env, Number(adminPlace[1]));
  const adminAdoptReq = /^\/api\/admin\/adoptions\/requests\/(\d+)\/(approve|decline)$/.exec(p);
  if (adminAdoptReq)
    return handleAdminAdoptions(req, env, {
      requestId: Number(adminAdoptReq[1]),
      decision: adminAdoptReq[2] as "approve" | "decline",
    });
  if (p === "/federation/peers" && m === "GET") return handleFederationPeers(req, env);
  if (p === "/federation/peers" && m === "POST") return handlePeerAdd(req, env); // look up, then add unvetted
  if (p === "/federation/peers" && m === "DELETE") return handlePeerRemove(req, env);
  if (p === "/federation/peers/trust" && m === "POST") return handlePeerTrust(req, env); // operator promote/block
  if (p === "/federation/gaps/seen" && m === "POST") return handleGapsSeen(req, env); // given-up records, seen
  if (p === "/federation/peers/sync" && m === "POST") return handlePeerSyncNow(req, env); // Sync now, one peer
  if (p === "/federation/peers/44net" && m === "POST") return handleFed44netAdd(req, env); // ARDC-verified onboarding
  if (p === "/federation/peers/follow" && m === "POST") return handlePeerFollow(req, env); // follow a discovered one
  if (p === "/federation/exchange" && m === "GET") return handlePeerExchange(req, env); // the instances trusted here
  // CBOR sync surface — fedwire frames (the canonical signed form); consumers prefer it over the JSON feeds
  if (p === "/federation/sync/summary" && m === "GET") return handleSyncSummary(req, env); // what is held, per origin
  if (p === "/federation/sync/origin" && m === "GET") return handleOriginSync(req, env); // one origin after a sequence
  const fedSync = /^\/federation\/sync\/([a-z-]+)$/.exec(p);
  if (fedSync && m === "GET") return handleFedSync(req, env, fedSync[1]!);
  // store-and-forward send: pack local records into an ACSFED batch, personal mail to FBB partners (sysop/operator secret)
  if (p === "/federation/bbs/enqueue" && m === "POST") return handleFedBbsEnqueue(req, env);
  // beacon tier: GET = this instance's presence datagram (the ingest box transmits it);
  // POST = a heard datagram into the trust-gated pipeline (ingest-gated)
  if (p === "/federation/beacon" && m === "GET") return handleBeaconEmit(req, env);
  if (p === "/federation/beacon" && m === "POST") return handleBeaconRx(req, env);
  // connected-mode delivery: a CBOR sync page pulled over an AX.25/NET-ROM circuit (ingest-gated)
  if (p === "/federation/frames" && m === "POST") return handleFramesRx(req, env);
  if (p === "/federation/packet/peers" && m === "GET") return handlePacketPeers(req, env); // ingest: who to dial
  if (p === "/federation/packet/status" && m === "POST") return handlePacketStatus(req, env); // ingest: a session
  if (p === "/federation/sync" && m === "POST") return handleFederationSync(req, env);
  if (p === "/federation/corroborate" && m === "POST") return handleCorroborate(req, env);
  if (p === "/federation/keys" && m === "GET") return handleFederationKeys(req, env);
  if (p === "/federation/tombstones" && m === "GET") return handleFederationTombstones(req, env); // delete propagation
  if (p === "/federation/notify" && m === "POST") return handleFederationNotify(req, env, ctx); // gossip push-to-pull
  if (p === "/federation/submit" && m === "POST") return handleFederationSubmit(req, env); // push-to-hub (NAT/firewall peers)
  if (p === "/federation/submit/marks" && m === "GET") return handleSubmitMarks(req, env); // where a spoke's feeds stand here
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
  if (p === "/ingest/check" && m === "GET") return handleIngestCheck(req, env);
  if (p === "/ingest/txgate" && m === "GET") return handleTxGate(req, env);
  if (p === "/ingest/enroll" && m === "POST") return handleEnroll(req, env);
  if (p === "/api/admin/stations" && m === "POST") return handleAdminAddStation(req, env);
  if (p === "/api/admin/boxes" && m === "GET") return handleListBoxes(req, env);
  if (p === "/api/admin/federation/sync" && m === "GET") return handleSyncStatus(req, env);
  if (p === "/api/admin/federation/sync" && m === "POST") return handleSyncNow(req, env, ctx);
  if (p === "/api/admin/boxes/codes" && m === "POST") return handleCreateEnrollCode(req, env);
  const revoke = /^\/api\/admin\/boxes\/([A-Za-z0-9_.-]+)\/revoke$/.exec(p);
  if (revoke && m === "POST") return handleRevokeBox(req, env, revoke[1]!);
  const boxTrust = /^\/api\/admin\/boxes\/([A-Za-z0-9_.-]+)\/trust$/.exec(p);
  if (boxTrust && m === "POST") return handleTrustBox(req, env, boxTrust[1]!);
  const boxServices = /^\/api\/admin\/boxes\/([A-Za-z0-9_.-]+)\/services$/.exec(p);
  if (boxServices && m === "POST") return handleBoxServices(req, env, boxServices[1]!);
  const boxFinds = /^\/api\/admin\/boxes\/([A-Za-z0-9_.-]+)\/finds$/.exec(p);
  if (boxFinds && m === "GET") return handleBoxFinds(req, env, boxFinds[1]!);
  if (p === "/api/admin/sites" && m === "GET") return handleListSites(req, env);
  if (p === "/api/admin/sites" && m === "POST") return handleAddSite(req, env);
  const siteFinds = /^\/api\/admin\/sites\/([A-Za-z0-9%-]+)\/finds$/.exec(p);
  if (siteFinds && m === "GET") return handleSiteFinds(req, env, siteFinds[1]!);
  const siteDel = /^\/api\/admin\/sites\/([A-Za-z0-9%-]+)$/.exec(p);
  if (siteDel && m === "DELETE") return handleRemoveSite(req, env, siteDel[1]!);
  if (p === "/outbox" && m === "GET") return outboxPending(req, env);
  if (p === "/outbox/ack" && m === "POST") return outboxAck(req, env);

  // live websocket -> region room
  if (p === "/ws") {
    const region = liveRegionOf(url);
    if (!region) return json({ error: `unknown region; this instance serves "${LIVE_REGION}"` }, { status: 400 });
    return env.ROOMS.get(region).fetch(req);
  }

  // auth (passkey + email magic-link). Sessions attribute logs and gate announce.
  if (p === "/auth/claim" && m === "POST") return handleClaim(req, env);
  if (p === "/auth/claims" && m === "POST") return handleClaimStart(req, env);
  if (p === "/auth/claims/status" && m === "POST") return handleClaimStatus(req, env);
  if (p === "/auth/passkeys" && m === "GET") return handleListPasskeys(req, env);
  const passkeyDel = /^\/auth\/passkeys\/([A-Za-z0-9_-]+)$/.exec(p);
  if (passkeyDel && m === "DELETE") return handleRemovePasskey(req, env, passkeyDel[1]!);
  if (p === "/auth/passkey/register/begin" && m === "POST") return handlePasskeyRegisterBegin(req, env);
  if (p === "/auth/passkey/register/finish" && m === "POST") return handlePasskeyRegisterFinish(req, env);
  if (p === "/auth/passkey/login/begin" && m === "POST") return handlePasskeyLoginBegin(req, env);
  if (p === "/auth/passkey/login/finish" && m === "POST") return handlePasskeyLoginFinish(req, env);
  if (p === "/auth/email/start" && m === "POST") return handleEmailStart(req, env);
  if (p === "/auth/email/verify" && (m === "POST" || m === "GET")) return handleEmailVerify(req, env);
  if (p === "/auth/email/change" && m === "POST") return handleEmailChange(req, env);
  if (p === "/auth/email/resend" && m === "POST") return handleEmailResend(req, env);
  if (p === "/auth/operator-link" && m === "POST") return handleOperatorLink(req, env);
  if (p === "/auth/session" && m === "GET") return handleSession(req, env);
  if (p === "/auth/callsign" && m === "POST") return handleChangeCallsign(req, env);
  if (p === "/auth/profile" && m === "POST") return handleProfileUpdate(req, env);
  if (p === "/api/my/profile" && m === "GET") return handleMyProfile(req, env);
  if (p === "/api/my/logged" && m === "GET") return handleMyLogged(req, env);
  if (p === "/api/my/hides" && m === "GET") return handleMyHides(req, env);
  // weather user-origination — PWS push (Ecowitt / WU) with a weather station's own key
  // weather user-origination — PWS push (Ecowitt / WU) under <call>-13
  if ((p === "/api/wx/submit" || p === "/api/wx/updateweatherstation") && (m === "GET" || m === "POST"))
    return handleWxSubmit(req, env);
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
  if (p === "/auth/logout" && m === "POST") return handleLogout(req, env);
  if (p === "/auth/logout-all" && m === "POST") return handleLogoutAll(req, env);

  // callsign control-verification: an RF challenge, the operator's bootstrap, and the badge status
  if (p === "/verify/aprs/start" && m === "POST") return startAprsChallenge(req, env);
  if (p === "/verify/operator" && m === "POST") return handleOperatorVerify(req, env);
  if (p === "/verify/aprs/status" && m === "GET") return aprsVerifyStatus(req, env);
  if (p === "/verify/ampr/start" && m === "POST") return startAmprChallenge(req, env);
  if (p === "/verify/ampr/check" && m === "POST") return checkAmprChallenge(req, env);
  if (p === "/verify/lotw/start" && m === "POST") return startLotwChallenge(req, env);
  if (p === "/verify/lotw/complete" && m === "POST") return completeLotwChallenge(req, env);
  if (p === "/verify/methods" && m === "GET") return verifyMethods(env);

  // callsign validity from public licence registers — a flag beside the call, never a gate
  if (p === "/api/licence" && m === "GET") return handleLicenceSources(req, env);
  if (p === "/api/licence/import" && m === "POST") return handleLicenceImport(req, env);
  if (p === "/api/licence/import/finish" && m === "POST") return handleLicenceImportFinish(req, env);
  const licenceMatch = /^\/api\/licence\/([^/]+)$/.exec(p);
  if (licenceMatch && m === "GET") return handleLicenceLookup(req, env, licenceMatch[1]!);

  // caching REST
  if (p === "/api/caches" && m === "GET") return handleCachesInBBox(req, env);
  if (p === "/api/offline/pack" && m === "GET") return handleOfflinePack(req, env); // a trip's offline pack
  if (p === "/api/offline/tiles" && m === "GET") return handleOfflineTiles(req, env); // where the offline map is
  if (p === TILES_PATH && (m === "GET" || m === "HEAD")) return handleTileArchive(req, env);
  if (p === "/api/caches" && m === "POST") return handleCreateCache(req, env);

  // enriched as-you-type search across caches + stations
  if (p === "/api/search" && m === "GET") return handleSearch(req, env);

  // community / gamification
  if (p === "/api/leaderboard" && m === "GET") return handleLeaderboard(req, env);
  if (p === "/api/corroborators" && m === "GET") return handleCorroborators(req, env);
  if (p === "/api/activity" && m === "GET") return handleActivity(req, env);
  const profileMatch = /^\/api\/profile\/([A-Za-z0-9-]+)$/.exec(p);
  if (profileMatch && m === "GET") return handleProfile(req, env, profileMatch[1]!);

  // shack: live station registry
  if (p === "/api/stations" && m === "GET") return handleStations(req, env);
  if (p === "/api/meshcom/nodes" && m === "GET") return handleMeshcomNodes(req, env);
  if (p === "/api/meshcom/links" && m === "GET") return handleMeshcomLinks(req, env);
  if (p === "/api/meshcom/groups" && m === "GET") return handleMeshcomGroups(req, env);
  const meshGroupMatch = /^\/api\/meshcom\/groups\/([^/]+)\/messages$/.exec(p);
  if (meshGroupMatch && m === "GET")
    return handleMeshcomGroupMessages(req, env, meshGroupMatch[1]!.replace(/%2A/gi, "*"));
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

  // shack interop + transports
  if (p === "/api/cot" && m === "GET") return handleCot(req, env, nowS());
  if (p === "/api/cot/stream" && m === "GET") return handleCotStream(req, env, nowS());
  if (p === "/api/ports" && m === "GET") return handlePorts(req, env);
  if (p === "/api/messages" && m === "GET") return handleMessages(req, env);
  if (p === "/api/messages/sent" && m === "POST") return handleSentMessage(req, env);
  if (p === "/api/mailbox" && m === "POST") return handleMailboxPost(req, env);
  if (p === "/api/mailbox" && m === "GET") return handleMailboxList(req, env);
  const mailboxMatch = /^\/api\/mailbox\/(\d+)$/.exec(p);
  if (mailboxMatch && m === "DELETE") return handleMailboxWithdraw(req, env, Number(mailboxMatch[1]));
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
  const cacheMediaThumb = /^\/api\/caches\/(\d+)\/media\/(\d+)\/thumb$/.exec(p);
  if (cacheMediaThumb && m === "PUT")
    return handlePutMediaThumb(req, env, Number(cacheMediaThumb[1]), Number(cacheMediaThumb[2]));
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

  // caches up for adoption, and one cache's offer + the caller's request
  if (p === "/api/adoptions" && m === "GET") return handleAdoptionList(env);
  const adoptMatch = /^\/api\/caches\/(\d+)\/adoption(\/request)?$/.exec(p);
  if (adoptMatch) return handleCacheAdoption(req, env, Number(adoptMatch[1]), adoptMatch[2] ? "request" : null);

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

  // radio commands: the signed-in player's FOUND/DNF/NOTE messages, and confirming a pending one
  if (p === "/api/radio/commands" && m === "GET") return handleRadioCommandsList(req, env);
  const radioDecision = /^\/api\/radio\/commands\/(\d+)\/(confirm|discard)$/.exec(p);
  if (radioDecision && m === "POST")
    return handleRadioCommandDecision(req, env, Number(radioDecision[1]), radioDecision[2] as "confirm" | "discard");

  // import: GET /api/import lists the sources, POST /api/import/:source runs one (admin)
  if (p === "/api/import" && m === "GET") return handleImportSources(req, env);
  const importMatch = /^\/api\/import\/([a-z]+)$/.exec(p);
  if (importMatch && m === "POST") return handleImport(req, env, importMatch[1]!);
  if (p === "/api/admin/imports" && m === "GET") return handleImportedPlaces(req, env);
  const importedPlace = /^\/api\/admin\/imports\/(\d+)$/.exec(p);
  if (importedPlace && m === "DELETE") return handleRemoveImportedPlace(req, env, Number(importedPlace[1]));

  return new Response("not found", { status: 404 });
}

/** The origins allowed to make *credentialed* (cookie-bearing) cross-origin requests —
 *  APP_URL, the instance's other addresses (EXTRA_ORIGINS) and any CORS_ORIGINS, each only when it is https
 *  or loopback: a page on a plain-http origin can be rewritten by anyone on its network path, so it never
 *  rides a member's cookie across origins (the app on that origin is same-origin and needs no CORS). An empty
 *  list allows none: an unconfigured instance serves only non-credentialed CORS, so no third-party page can
 *  ride a signed-in user's cookie. */
export function corsAllowlist(env: Env): Set<string> {
  const list = new Set<string>();
  const add = (u?: string) => {
    const s = u?.trim();
    if (!s) return;
    try {
      const origin = new URL(s).origin;
      if (secureOrigin(origin)) list.add(origin);
    } catch {
      /* ignore a malformed entry */
    }
  };
  add(env.APP_URL);
  for (const o of extraOrigins(env)) add(o);
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
  const allowed = corsAllowlist(env);
  if (allowed.has(origin)) {
    // an allowlisted app origin: reflect it and let the session cookie ride
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Credentials", "true");
  } else if (allowed.size > 0) {
    // any other origin on a configured instance: readable (the public read API), never credentialed
    h.set("Access-Control-Allow-Origin", origin);
  } else {
    // no allowlist at all: a wildcard, which browsers never combine with cookies
    h.set("Access-Control-Allow-Origin", "*");
  }
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", req.headers.get("Access-Control-Request-Headers") ?? "content-type");
  h.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
