// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * feeds.ts — RSS 2.0 feeds over the public data. Platform feeds (activity, new caches, bulletins,
 * leaderboard) and user-centric feeds (a callsign's finds, badge awards and scoring). Runtime-neutral
 * (Worker / Node / Bun); reads via the D1-style `env.DB`.
 *
 *   GET /feeds/activity.xml      recent finds / hides / DNFs across the network
 *   GET /feeds/caches.xml        recently published public caches
 *   GET /feeds/bulletins.xml     public APRS bulletins
 *   GET /feeds/leaderboard.xml   top finders (snapshot)
 *   GET /feeds/u/<callsign>.xml  a callsign's finds + badges + scoring
 */
import type { Env } from "./env.js";
import { xml } from "./app.js";
import { userFeedPath } from "@aprsweb/shared";
import { appBase, surfaceUrl, xmlEscape } from "./sitemap.js";

const now = () => Math.floor(Date.now() / 1000);
const rfc822 = (unixSec: number) => new Date(unixSec * 1000).toUTCString();

interface Item { title: string; link: string; description: string; guid: string; pubDate: number; author?: string }

function rss(opts: { title: string; link: string; description: string; selfPath: string; env: Env; items: Item[] }): Response {
  const self = `${appBase(opts.env)}${opts.selfPath}`;
  const items = opts.items.map((it) =>
    `    <item>\n` +
    `      <title>${xmlEscape(it.title)}</title>\n` +
    `      <link>${xmlEscape(it.link)}</link>\n` +
    `      <guid isPermaLink="false">${xmlEscape(it.guid)}</guid>\n` +
    `      <pubDate>${rfc822(it.pubDate)}</pubDate>\n` +
    (it.author ? `      <dc:creator>${xmlEscape(it.author)}</dc:creator>\n` : "") +
    `      <description>${xmlEscape(it.description)}</description>\n` +
    `    </item>`,
  ).join("\n");
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `  <channel>\n` +
    `    <title>${xmlEscape(opts.title)}</title>\n` +
    `    <link>${xmlEscape(opts.link)}</link>\n` +
    `    <atom:link href="${xmlEscape(self)}" rel="self" type="application/rss+xml"/>\n` +
    `    <description>${xmlEscape(opts.description)}</description>\n` +
    `    <lastBuildDate>${rfc822(now())}</lastBuildDate>\n` +
    `    <generator>aprscaching</generator>\n` +
    `${items}\n` +
    `  </channel>\n</rss>\n`;
  return xml(body, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
}

const verb = (t: string) => (t === "found" ? "found" : t === "dnf" ? "couldn't find" : t === "note" ? "noted" : t);

/** GET /feeds/activity.xml */
export async function handleActivityFeed(_req: Request, env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(
    `SELECT l.id, l.logger_call AS loggerCall, l.ts, l.log_type AS logType, l.verified, l.tier,
            c.code AS cacheCode, c.title AS cacheTitle
       FROM cache_logs l JOIN caches c ON c.id = l.cache_id
       ORDER BY l.ts DESC LIMIT 50`,
  ).all<any>()).results;
  const items: Item[] = rows.map((r) => ({
    title: `${r.loggerCall} ${verb(r.logType)} ${r.cacheTitle} (${r.cacheCode})`,
    link: surfaceUrl(env, "activity"),
    description: `${r.loggerCall} ${verb(r.logType)} ${r.cacheTitle}` +
      `${r.logType === "found" ? ` · ${r.verified ? `verified Tier ${r.tier ?? "?"}` : "unverified"}` : ""}.`,
    guid: `find:${r.id}`, pubDate: r.ts, author: r.loggerCall,
  }));
  return rss({ title: "aprscaching — Activity", link: surfaceUrl(env, "activity"),
    description: "Recent finds, hides and DNFs across the network.", selfPath: "/feeds/activity.xml", env, items });
}

/** GET /feeds/caches.xml */
export async function handleCachesFeed(_req: Request, env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(
    `SELECT code, title, type, owner_call AS ownerCall, difficulty, terrain, created_at AS createdAt
       FROM caches WHERE status != 'archived' AND source = 'native'
       ORDER BY created_at DESC LIMIT 50`,
  ).all<any>()).results;
  const items: Item[] = rows.map((r) => ({
    title: `${r.title} (${r.code})`,
    link: `${appBase(env)}/?cache=${encodeURIComponent(r.code)}`,
    description: `New ${String(r.type).replace(/_/g, " ")} cache by ${r.ownerCall} · D${r.difficulty}/T${r.terrain}.`,
    guid: `cache:${r.code}`, pubDate: r.createdAt, author: r.ownerCall,
  }));
  return rss({ title: "aprscaching — New caches", link: surfaceUrl(env, null),
    description: "Recently published public caches.", selfPath: "/feeds/caches.xml", env, items });
}

/** GET /feeds/bulletins.xml */
export async function handleBulletinsFeed(_req: Request, env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(
    `SELECT id, from_call AS fromCall, to_call AS toCall, subject, body, posted_at AS postedAt
       FROM bbs_messages WHERE type = 'B' AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY posted_at DESC LIMIT 50`,
  ).bind(now()).all<any>()).results;
  const items: Item[] = rows.map((r) => ({
    title: `${r.toCall}: ${r.subject || r.body.slice(0, 60)}`,
    link: surfaceUrl(env, "bbs"),
    description: r.body, guid: `bulletin:${r.id}`, pubDate: r.postedAt, author: r.fromCall,
  }));
  return rss({ title: "aprscaching — Bulletins", link: surfaceUrl(env, "bbs"),
    description: "Public APRS bulletins.", selfPath: "/feeds/bulletins.xml", env, items });
}

/** GET /feeds/leaderboard.xml — a snapshot; all items share the build time. */
export async function handleLeaderboardFeed(_req: Request, env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(
    `SELECT logger_call AS loggerCall, COUNT(DISTINCT cache_id) AS finds
       FROM cache_logs WHERE log_type='found' AND verified=1
       GROUP BY logger_call ORDER BY finds DESC LIMIT 25`,
  ).all<any>()).results;
  const t = now();
  const items: Item[] = rows.map((r, i) => ({
    title: `#${i + 1} ${r.loggerCall} — ${r.finds} verified finds`,
    link: `${appBase(env)}${userFeedPath(r.loggerCall)}`,
    description: `${r.loggerCall} ranks #${i + 1} with ${r.finds} verified finds.`,
    guid: `rank:${r.loggerCall}:${t}`, pubDate: t, author: r.loggerCall,
  }));
  return rss({ title: "aprscaching — Leaderboard", link: surfaceUrl(env, "ranks"),
    description: "Top finders, ranked by verified finds.", selfPath: "/feeds/leaderboard.xml", env, items });
}

/** GET /feeds/u/<callsign>.xml — a callsign's finds, badge awards and scoring. */
export async function handleUserFeed(_req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const finds = (await env.DB.prepare(
    `SELECT l.id, l.ts, l.tier, l.verified, c.code AS cacheCode, c.title AS cacheTitle
       FROM cache_logs l JOIN caches c ON c.id = l.cache_id
       WHERE l.logger_call = ? AND l.log_type = 'found' ORDER BY l.ts DESC LIMIT 50`,
  ).bind(cs).all<any>()).results;
  const badges = (await env.DB.prepare(
    "SELECT badge, earned_at AS earnedAt FROM achievements WHERE callsign = ? ORDER BY earned_at DESC LIMIT 50",
  ).bind(cs).all<any>()).results;
  const findCount = (await env.DB.prepare(
    "SELECT COUNT(DISTINCT cache_id) AS n FROM cache_logs WHERE logger_call = ? AND log_type='found' AND verified=1",
  ).bind(cs).first<{ n: number }>())?.n ?? 0;
  const hides = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM caches WHERE owner_call = ? AND source='native' AND status!='archived'",
  ).bind(cs).first<{ n: number }>())?.n ?? 0;

  const items: Item[] = [
    ...finds.map((r) => ({
      title: `Found ${r.cacheTitle} (${r.cacheCode})`,
      link: `${appBase(env)}/?cache=${encodeURIComponent(r.cacheCode)}`,
      description: `${cs} found ${r.cacheTitle}` + (r.verified ? ` · verified Tier ${r.tier ?? "?"}` : " · unverified") + ".",
      guid: `find:${r.id}`, pubDate: r.ts, author: cs,
    })),
    ...badges.map((b) => ({
      title: `Earned badge: ${b.badge}`,
      link: `${appBase(env)}${userFeedPath(cs)}`,
      description: `${cs} earned the “${b.badge}” badge.`,
      guid: `badge:${cs}:${b.badge}`, pubDate: b.earnedAt, author: cs,
    })),
  ].sort((a, b) => b.pubDate - a.pubDate).slice(0, 60);

  return rss({
    title: `aprscaching — ${cs}`,
    link: `${appBase(env)}/?view=profile&call=${encodeURIComponent(cs)}`,
    description: `${cs} — ${findCount} verified finds · ${hides} hides · ${badges.length} badges.`,
    selfPath: userFeedPath(cs), env, items,
  });
}
