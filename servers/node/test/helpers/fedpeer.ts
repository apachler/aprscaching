// SPDX-License-Identifier: AGPL-3.0-or-later
// Real federation peers for tests: each instance is the gateway's own `handle()` over a fresh
// migrated SQLite, reached through a stubbed global fetch keyed by origin. A test can patch a
// descriptor or route a peer's sync pages to an instance holding a different key, which is how a
// hijacked or impersonating peer looks from the outside.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { makeD1 } from "../../src/d1.js";
import { migrate } from "../../src/migrate.js";
import { handle } from "@aprscaching/gateway/app";
import type { Env } from "@aprscaching/gateway/env";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations");

const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64");
const b64url = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64url");

export interface FedKey {
  /** FED_PRIVATE_KEY value: base64(JSON{pkcs8,pub}). */
  env: string;
  /** Raw Ed25519 public key, base64url. */
  pub: string;
  priv: CryptoKey;
}

export async function newFedKey(): Promise<FedKey> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkcs8 = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return { env: Buffer.from(JSON.stringify({ pkcs8, pub })).toString("base64"), pub, priv: kp.privateKey };
}

const stable = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
};

/** A rotation record: `next` vouched for by `prev` at `at`. */
export async function rotation(prev: FedKey, next: FedKey, at: number) {
  const msg = new TextEncoder().encode(stable({ key: next.pub, prevKey: prev.pub, at }));
  const sig = b64url(await crypto.subtle.sign("Ed25519", prev.priv, msg));
  return { key: next.pub, prevKey: prev.pub, at, sig };
}

/** A signed registry document binding instances to keys, signed by `authority`. */
export async function signedRegistry(
  authority: FedKey,
  at: number,
  entries: Array<{ instance: string; key?: string; url?: string; operator?: string }>,
) {
  const msg = new TextEncoder().encode(stable({ at, entries }));
  const sig = b64url(await crypto.subtle.sign("Ed25519", authority.priv, msg));
  return { entries, at, sig };
}

export function freshDb(): { sqlite: Database.Database; DB: ReturnType<typeof makeD1> } {
  const sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  return { sqlite, DB: makeD1(sqlite) };
}

/** An instance env over its own database (or a shared one, to model one instance with two keys). */
export function instanceEnv(instance: string, key: FedKey | null, extra: Record<string, unknown> = {}, db?: unknown) {
  return {
    DB: db ?? freshDb().DB,
    INSTANCE: instance,
    INGEST_SECRET: "test-ingest-secret",
    ...(key ? { FED_PRIVATE_KEY: key.env } : {}),
    ...extra,
  } as unknown as Env;
}

let cacheSeq = 0;
/** A native, public cache on an instance, so its feeds have something to serve. */
export async function addCache(env: Env, updatedAt = 1000): Promise<number> {
  const n = ++cacheSeq;
  const r = await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at)
     VALUES (?, 'OE8APR', ?, 'traditional', 47.07, 15.42, ?, ?)`,
  )
    .bind(`AC-T${n}`, `Test cache ${n}`, updatedAt, updatedAt)
    .run();
  return Number(r.meta.last_row_id);
}

export type Serve = (req: Request) => Promise<Response>;
export const serve =
  (env: Env): Serve =>
  (req) =>
    handle(req, env, { waitUntil: () => {} });

/** Serve `env`, but rewrite its descriptor JSON through `patch`. */
export const withDescriptor =
  (inner: Serve, patch: (wk: Record<string, unknown>) => Record<string, unknown>): Serve =>
  async (req) => {
    const res = await inner(req);
    if (new URL(req.url).pathname !== "/.well-known/aprscaching") return res;
    return Response.json(patch((await res.json()) as Record<string, unknown>));
  };

/** Descriptor from one instance, sync pages from another — a peer whose frames are signed by some other key. */
export const splitServe =
  (descriptor: Serve, pages: Serve): Serve =>
  (req) =>
    new URL(req.url).pathname.startsWith("/federation/sync/") ? pages(req) : descriptor(req);

/** Route global fetch by origin; anything unrouted is a network failure. Returns the route table. */
export function stubFetch(routes: Record<string, Serve> = {}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const route = routes[new URL(req.url).origin];
    if (!route) throw new TypeError(`fetch failed: no route for ${req.url}`);
    return route(req);
  });
  return routes;
}

/** The fedwire frames an instance serves on one sync feed. */
export async function servedFrames(env: Env, type = "cache"): Promise<Uint8Array[]> {
  const { decodeFedSyncPage } = await import("@aprscaching/gateway/fedsync");
  const res = await serve(env)(new Request(`https://x/federation/sync/${type}?since=0&limit=500`));
  return decodeFedSyncPage(new Uint8Array(await res.arrayBuffer())).frames;
}

export async function peerRow(env: Env, url: string) {
  return env.DB.prepare("SELECT * FROM fed_peers WHERE url = ?").bind(url).first<Record<string, unknown>>();
}

export async function remoteCacheCount(env: Env, origin: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches WHERE origin = ?")
    .bind(origin)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
