// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * toolregistries.ts — the tool registries the Shack's Tools app lists, and the copies this instance fetches of
 * them. Tools never run here: a registry is a signed list of tools that the player's browser verifies and runs
 * sandboxed. This module only says which registries there are, and carries their files.
 *
 * The list. The instance's registries are the project registry bundled with the app (served at
 * /tools/registry.json, on unless the sysop switches it off) plus the ones the sysop adds; TOOL_REGISTRIES in the
 * environment replaces them and the page shows it read-only. A player may add registries of their own while
 * TOOL_REGISTRIES_PLAYERS is on; switched off, those are neither listed nor fetched, and stay stored until the
 * player removes them. Each entry pins its authority key: the person who adds it compares the key's fingerprint
 * with the publisher's and confirms it, and the browser checks every registry file against that key. A file
 * signed by another key shows as "key changed" until the same person confirms the new key.
 *
 * The carrier. With TOOL_REGISTRIES_PROXY on, the browser fetches an added registry, the manifests its entries
 * name and the scripts those name through this instance, so a player's address never reaches the registry's
 * host, and the last good copy keeps serving while the internet is down. The gateway fetches without
 * credentials, over https on every hop and never to a private or LAN address whatever the federation settings
 * allow (fetchguard.ts toolFetch), keeps each file for an hour, caps each file and each registry's total, and
 * fetches only files the registry itself leads to. It decides no trust: the browser verifies every signature
 * against the pinned key.
 *
 *   GET    /api/tools/registries                     the effective list for this visitor
 *   GET    /api/tools/registries/preview?spec=…      a registry file before it is added, to compare its key
 *   GET    /api/tools/registries/:id/file?url=…      one file of a registry, as this instance last fetched it
 *   GET    /api/admin/tool-registries                the instance's list, with disabled entries (sysop)
 *   POST   /api/admin/tool-registries                {spec, authority, label?} add, its key confirmed (sysop)
 *   PATCH  /api/admin/tool-registries/:id            {enabled?, label?} (sysop)
 *   POST   /api/admin/tool-registries/:id/confirm    {authority} pin the key the file now names (sysop)
 *   DELETE /api/admin/tool-registries/:id            remove (sysop; the project registry is switched off instead)
 *   GET|POST /api/my/tool-registries, PATCH|DELETE /api/my/tool-registries/:id, POST …/:id/confirm
 *                                                    the same for the signed-in player's own registries
 */
import {
  BUILTIN_TOOL_REGISTRY,
  INSTANCE_REGISTRIES_MAX,
  REGISTRIES_PER_ACCOUNT,
  defaultRegistryLabel,
  isAuthorityKey,
  parseToolRegistriesEnv,
  registryLabel,
  registrySourceUrl,
  type RegistryScope,
  type ToolRegistryEntry,
} from "@aprscaching/shared";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { requireSysop } from "./admin.js";
import { sessionIdentity } from "./auth.js";
import { actorOf, audit } from "./moderation.js";
import { clientIp, rateLimited, rateLimitedDurable } from "./corroborate_privacy.js";
import { readCappedBody, toolFetch, ToolFetchRefused } from "./fetchguard.js";
import { loadSiteSettings, setting } from "./siteconfig.js";
import { nowS } from "./util/time.js";

/** How long a fetched copy serves before the next request fetches it again. */
export const REGISTRY_COPY_TTL_S = 3600;
/** How long after a failed fetch the next one waits, serving the last good copy meanwhile. */
const RETRY_AFTER_FAIL_S = 300;
/** The largest registry file, manifest and script fetched, in bytes. */
export const REGISTRY_FILE_CAP = { registry: 256 * 1024, manifest: 64 * 1024, script: 512 * 1024 } as const;
/** The most bytes one registry's copies may take together. */
const REGISTRY_TOTAL_CAP = 4 * 1024 * 1024;
/** The most entries of one registry whose files are fetched. */
const REGISTRY_ENTRIES_MAX = 200;
/** Upstream fetches one player's registries may cause in an hour. */
export const PLAYER_FETCHES_PER_HOUR = 60;
/**
 * Carried-file requests one client address may make in a minute: browsing a registry of REGISTRY_ENTRIES_MAX
 * tools reads its file, each manifest and each script once.
 */
export const FILE_REQUESTS_PER_MIN = 600;
/** Changes one person may make to a registry list in an hour. */
const WRITES_PER_HOUR = 60;
const FETCH_TIMEOUT_MS = 10_000;

const flag = (v: string | undefined): boolean => !/^(0|false|no)$/i.test((v ?? "").trim());
/** Whether players may add registries of their own (TOOL_REGISTRIES_PLAYERS). */
const playersMayAdd = (env: Env): boolean => flag(setting(env, "TOOL_REGISTRIES_PLAYERS"));
/** Whether added registries are fetched through this instance (TOOL_REGISTRIES_PROXY). */
const proxyOn = (env: Env): boolean => flag(setting(env, "TOOL_REGISTRIES_PROXY"));

interface Row {
  id: string;
  account_id: string | null;
  spec: string;
  url: string;
  authority: string;
  label: string;
  enabled: number;
  created_at: number;
  confirmed_at: number;
  added_by: string;
}

const builtinEntry = (enabled: boolean): ToolRegistryEntry => ({
  ...BUILTIN_TOOL_REGISTRY,
  scope: "instance",
  enabled,
  builtin: true,
});

const entryOf = (r: Row): ToolRegistryEntry => ({
  id: r.id,
  scope: r.account_id ? "account" : "instance",
  spec: r.spec,
  url: r.url,
  authority: r.authority,
  label: r.label,
  enabled: r.enabled === 1,
});

/** A registry on this instance's own origin (the bundled one, or an environment path) is never carried. */
const onThisOrigin = (e: ToolRegistryEntry): boolean => !!e.builtin || e.url.startsWith("/");

/** The instance's registries and where they come from; an unreadable TOOL_REGISTRIES lists none, and says why. */
async function instanceRegistries(
  env: Env,
): Promise<{ source: "env" | "site"; registries: ToolRegistryEntry[]; envError?: string }> {
  const raw = env.TOOL_REGISTRIES;
  if (typeof raw === "string" && raw.trim() !== "") {
    const r = parseToolRegistriesEnv(raw);
    return "error" in r
      ? { source: "env", registries: [], envError: r.error }
      : { source: "env", registries: r.entries };
  }
  const rows = (
    await env.DB.prepare("SELECT * FROM tool_registries WHERE account_id IS NULL ORDER BY created_at, id").all<Row>()
  ).results;
  const builtin = rows.find((r) => r.id === BUILTIN_TOOL_REGISTRY.id);
  return {
    source: "site",
    registries: [
      builtinEntry(builtin ? builtin.enabled === 1 : true),
      ...rows.filter((r) => r !== builtin).map(entryOf),
    ],
  };
}

async function accountRegistries(env: Env, accountId: string): Promise<ToolRegistryEntry[]> {
  return (
    await env.DB.prepare("SELECT * FROM tool_registries WHERE account_id=? ORDER BY created_at, id")
      .bind(accountId)
      .all<Row>()
  ).results.map(entryOf);
}

/** The view the browser gets of one registry: whether it fetches the files through this instance. */
const withCarrier = (env: Env, e: ToolRegistryEntry) => ({ ...e, proxied: proxyOn(env) && !onThisOrigin(e) });

/** GET /api/tools/registries — the enabled instance registries, and the player's own while players may add them. */
async function handleEffective(req: Request, env: Env): Promise<Response> {
  const inst = await instanceRegistries(env);
  const me = await sessionIdentity(req, env);
  const allowed = playersMayAdd(env);
  const own = me ? await accountRegistries(env, me.accountId) : [];
  return json({
    registries: [
      ...inst.registries.filter((e) => e.enabled).map((e) => withCarrier(env, e)),
      ...(allowed ? own.map((e) => withCarrier(env, e)) : []),
    ],
    players: { allowed, signedIn: !!me, stored: own.length },
    proxy: proxyOn(env),
  });
}

// ---- writes, shared by the sysop's list and a player's own ----

const randomId = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

interface Scope {
  scope: RegistryScope;
  accountId: string | null;
  actor: string;
}

async function rowById(env: Env, s: Scope, id: string): Promise<Row | null> {
  return s.accountId
    ? await env.DB.prepare("SELECT * FROM tool_registries WHERE id=? AND account_id=?")
        .bind(id, s.accountId)
        .first<Row>()
    : await env.DB.prepare("SELECT * FROM tool_registries WHERE id=? AND account_id IS NULL").bind(id).first<Row>();
}

const body = async (req: Request): Promise<Record<string, unknown>> =>
  ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

const forgetCopies = (env: Env, id: string) =>
  env.DB.prepare("DELETE FROM tool_registry_files WHERE registry_id=?").bind(id);

function auditOf(env: Env, s: Scope, action: string, id: string, label: string, reason: string) {
  return s.scope === "instance"
    ? [audit(env, { actor: s.actor, action, kind: "tool-registry", id, label, reason })]
    : [];
}

async function handleAdd(req: Request, env: Env, s: Scope): Promise<Response> {
  const b = await body(req);
  const where = registrySourceUrl(b.spec ?? b.url);
  if ("error" in where) return json({ error: where.error }, { status: 400 });
  if (!isAuthorityKey(b.authority))
    return json({ error: "authority must be the registry's Ed25519 public key, base64url" }, { status: 400 });
  const existing = s.accountId ? await accountRegistries(env, s.accountId) : (await instanceRegistries(env)).registries;
  const cap = s.accountId ? REGISTRIES_PER_ACCOUNT : INSTANCE_REGISTRIES_MAX;
  if (existing.filter((e) => !e.builtin).length >= cap)
    return json({ error: `at most ${cap} registries; remove one first` }, { status: 409 });
  if (existing.some((e) => e.url === where.url))
    return json({ error: "this registry is already in the list" }, { status: 409 });
  const now = nowS();
  const row: Row = {
    id: randomId(),
    account_id: s.accountId,
    spec: where.spec,
    url: where.url,
    authority: b.authority,
    label: registryLabel(b.label, defaultRegistryLabel(where.url)),
    enabled: 1,
    created_at: now,
    confirmed_at: now,
    added_by: s.actor,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tool_registries (id, account_id, spec, url, authority, label, enabled, created_at, confirmed_at, added_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      row.id,
      row.account_id,
      row.spec,
      row.url,
      row.authority,
      row.label,
      row.enabled,
      row.created_at,
      row.confirmed_at,
      row.added_by,
    ),
    ...auditOf(env, s, "add", row.id, row.label, `${row.url} pinned to ${row.authority}`),
  ]);
  return json({ registry: entryOf(row) }, { status: 201 });
}

async function handlePatch(req: Request, env: Env, s: Scope, id: string): Promise<Response> {
  const b = await body(req);
  const enabled = typeof b.enabled === "boolean" ? b.enabled : undefined;
  if (b.enabled !== undefined && enabled === undefined)
    return json({ error: "enabled is true or false" }, { status: 400 });
  // the bundled registry has no row while it is on; switching it off stores one
  if (s.scope === "instance" && id === BUILTIN_TOOL_REGISTRY.id) {
    if (enabled === undefined)
      return json({ error: "the project registry can only be switched on or off" }, { status: 400 });
    const now = nowS();
    const B = BUILTIN_TOOL_REGISTRY;
    await env.DB.batch([
      enabled
        ? env.DB.prepare("DELETE FROM tool_registries WHERE id=?").bind(B.id)
        : env.DB.prepare(
            `INSERT INTO tool_registries (id, account_id, spec, url, authority, label, enabled, created_at, confirmed_at, added_by)
             VALUES (?, NULL, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled=0`,
          ).bind(B.id, B.spec, B.url, B.authority, B.label, now, now, s.actor),
      ...auditOf(env, s, enabled ? "enable" : "disable", B.id, B.label, B.url),
    ]);
    return json({ registry: builtinEntry(enabled) });
  }
  const row = await rowById(env, s, id);
  if (!row) return json({ error: "no such registry" }, { status: 404 });
  const label = b.label !== undefined ? registryLabel(b.label, row.label) : row.label;
  const on = enabled === undefined ? row.enabled : enabled ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare("UPDATE tool_registries SET label=?, enabled=? WHERE id=?").bind(label, on, id),
    ...(on !== row.enabled ? auditOf(env, s, on ? "enable" : "disable", id, label, row.url) : []),
  ]);
  return json({ registry: entryOf({ ...row, label, enabled: on }) });
}

async function handleConfirm(req: Request, env: Env, s: Scope, id: string): Promise<Response> {
  const b = await body(req);
  if (!isAuthorityKey(b.authority))
    return json({ error: "authority must be the registry's Ed25519 public key, base64url" }, { status: 400 });
  const row = await rowById(env, s, id);
  if (!row || id === BUILTIN_TOOL_REGISTRY.id) return json({ error: "no such registry" }, { status: 404 });
  const now = nowS();
  await env.DB.batch([
    env.DB.prepare("UPDATE tool_registries SET authority=?, confirmed_at=? WHERE id=?").bind(b.authority, now, id),
    ...auditOf(env, s, "confirm", id, row.label, `${row.authority} → ${b.authority}`),
  ]);
  return json({ registry: entryOf({ ...row, authority: b.authority, confirmed_at: now }) });
}

async function handleRemove(env: Env, s: Scope, id: string): Promise<Response> {
  if (s.scope === "instance" && id === BUILTIN_TOOL_REGISTRY.id)
    return json({ error: "the project registry is switched off, not removed" }, { status: 400 });
  const row = await rowById(env, s, id);
  if (!row) return json({ error: "no such registry" }, { status: 404 });
  await env.DB.batch([
    forgetCopies(env, id),
    env.DB.prepare("DELETE FROM tool_registries WHERE id=?").bind(id),
    ...auditOf(env, s, "remove", id, row.label, row.url),
  ]);
  return json({ removed: true });
}

async function routeWrites(req: Request, env: Env, s: Scope, rest: string): Promise<Response> {
  const m = req.method;
  if (await rateLimitedDurable(env, `toolreg-write:${s.accountId ?? s.actor}`, Date.now(), WRITES_PER_HOUR, 3600_000))
    return json({ error: "too many changes; try again later" }, { status: 429 });
  if (rest === "" && m === "POST") return handleAdd(req, env, s);
  const one = /^\/([A-Za-z0-9_-]{1,64})(\/confirm)?$/.exec(rest);
  if (one && one[2] && m === "POST") return handleConfirm(req, env, s, one[1]!);
  if (one && !one[2] && m === "PATCH") return handlePatch(req, env, s, one[1]!);
  if (one && !one[2] && m === "DELETE") return handleRemove(env, s, one[1]!);
  return new Response("method not allowed", { status: 405 });
}

/** /api/admin/tool-registries[/…] — the sysop's (or the operator secret's). */
export async function handleAdminToolRegistries(req: Request, env: Env, rest: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  await loadSiteSettings(env);
  const inst = await instanceRegistries(env);
  if (rest === "" && req.method === "GET")
    return json({ ...inst, max: INSTANCE_REGISTRIES_MAX, proxy: proxyOn(env), playersAllowed: playersMayAdd(env) });
  if (inst.source === "env")
    return json(
      { error: "TOOL_REGISTRIES is set by the environment, which wins; change it there and restart the gateway" },
      { status: 409 },
    );
  return routeWrites(req, env, { scope: "instance", accountId: null, actor: await actorOf(req, env) }, rest);
}

/** /api/my/tool-registries[/…] — the signed-in player's own registries. */
export async function handleMyToolRegistries(req: Request, env: Env, rest: string): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  await loadSiteSettings(env);
  const allowed = playersMayAdd(env);
  if (rest === "" && req.method === "GET")
    return json({ allowed, registries: await accountRegistries(env, me.accountId), max: REGISTRIES_PER_ACCOUNT });
  // while players may not add registries, the player can still remove the ones kept for them
  if (!allowed && req.method !== "DELETE")
    return json({ error: "this instance does not let players add tool registries" }, { status: 403 });
  return routeWrites(req, env, { scope: "account", accountId: me.accountId, actor: me.callsign }, rest);
}

// ---- the carrier ----

type FileKind = keyof typeof REGISTRY_FILE_CAP;

interface FileRow {
  url: string;
  body: string | null;
  content_type: string | null;
  bytes: number;
  fetched_at: number | null;
  tried_at: number;
  error: string | null;
}

const httpsUrl = (u: string, base?: string): string | null => {
  try {
    const x = new URL(u, base);
    x.hash = "";
    return x.protocol === "https:" ? x.href : null;
  } catch {
    return null;
  }
};

const parseJson = (s: string | null | undefined): unknown => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** The manifests a registry file names, resolved against the registry's address. */
function manifestUrls(registryUrl: string, doc: unknown): string[] {
  const entries = (doc as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const e of entries.slice(0, REGISTRY_ENTRIES_MAX)) {
    const u =
      typeof (e as { entry?: unknown })?.entry === "string"
        ? httpsUrl((e as { entry: string }).entry, registryUrl)
        : null;
    if (u) out.push(u);
  }
  return out;
}

/** The script a manifest names (`entry`, default `tool.js`), resolved against the manifest's address. */
function scriptUrl(manifestUrl: string, doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return null;
  const entry = (doc as { entry?: unknown }).entry;
  return httpsUrl(typeof entry === "string" ? entry : "tool.js", manifestUrl);
}

/**
 * What each registry leads to (url → kind), derived from the copies this instance holds, per database. Every
 * carried file asks it, and deriving it parses the registry file and every manifest; a new registry or manifest copy
 * drops the registry's entry (forgetLeads), and the generation keeps a derivation that raced such a write from
 * being kept.
 */
const leadsCache = new WeakMap<object, { gen: number; byRegistry: Map<string, Map<string, FileKind>> }>();
const LEADS_CACHED_MAX = 256;

function leadsStore(env: Env) {
  let store = leadsCache.get(env.DB);
  if (!store) leadsCache.set(env.DB, (store = { gen: 0, byRegistry: new Map() }));
  return store;
}

function forgetLeads(env: Env, registryId: string): void {
  const store = leadsStore(env);
  store.gen++;
  for (const k of store.byRegistry.keys()) if (k.startsWith(`${registryId} `)) store.byRegistry.delete(k);
}

async function leadsOf(env: Env, reg: ToolRegistryEntry): Promise<Map<string, FileKind>> {
  const store = leadsStore(env);
  const key = `${reg.id} ${reg.url}`;
  const hit = store.byRegistry.get(key);
  if (hit) return hit;
  const gen = store.gen;
  const rows = (
    await env.DB.prepare("SELECT url, body FROM tool_registry_files WHERE registry_id=?").bind(reg.id).all<{
      url: string;
      body: string | null;
    }>()
  ).results;
  const bodies = new Map(rows.map((r) => [r.url, r.body]));
  const manifests = manifestUrls(reg.url, parseJson(bodies.get(reg.url)));
  const leads = new Map<string, FileKind>();
  for (const m of manifests) {
    const s = scriptUrl(m, parseJson(bodies.get(m)));
    if (s) leads.set(s, "script");
  }
  for (const m of manifests) leads.set(m, "manifest");
  leads.set(reg.url, "registry");
  if (store.gen === gen) {
    if (store.byRegistry.size >= LEADS_CACHED_MAX) store.byRegistry.delete(store.byRegistry.keys().next().value!);
    store.byRegistry.set(key, leads);
  }
  return leads;
}

/**
 * What `url` is to the registry, judged from the copies this instance holds: the registry file itself, a manifest
 * its entries name, or a script one of those manifests names. Null for anything else: the carrier fetches only
 * what the registry leads to.
 */
async function kindOf(env: Env, reg: ToolRegistryEntry, url: string): Promise<FileKind | null> {
  if (url === reg.url) return "registry";
  return (await leadsOf(env, reg)).get(url) ?? null;
}

/** Drop the copies a refreshed registry no longer leads to, so they stop counting against its total. */
async function pruneCopies(env: Env, reg: ToolRegistryEntry, registryBody: string): Promise<void> {
  const manifests = manifestUrls(reg.url, parseJson(registryBody));
  const keep = new Set([reg.url, ...manifests]);
  const rows = (
    await env.DB.prepare("SELECT url, body FROM tool_registry_files WHERE registry_id=?").bind(reg.id).all<{
      url: string;
      body: string | null;
    }>()
  ).results;
  const bodies = new Map(rows.map((r) => [r.url, r.body]));
  for (const m of manifests) {
    const s = scriptUrl(m, parseJson(bodies.get(m)));
    if (s) keep.add(s);
  }
  const drop = rows.filter((r) => !keep.has(r.url));
  if (drop.length)
    await env.DB.batch(
      drop.map((r) =>
        env.DB.prepare("DELETE FROM tool_registry_files WHERE registry_id=? AND url=?").bind(reg.id, r.url),
      ),
    );
}

const CONTENT_TYPE: Record<FileKind, string> = {
  registry: "application/json; charset=utf-8",
  manifest: "application/json; charset=utf-8",
  // the browser reads a script as text and hands it to the sandbox; it is never run from this origin
  script: "text/plain; charset=utf-8",
};

function serveCopy(row: FileRow, kind: FileKind, reg: ToolRegistryEntry, stale: boolean): Response {
  return new Response(row.body, {
    headers: {
      "content-type": CONTENT_TYPE[kind],
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": reg.scope === "account" ? "private, no-store" : "public, max-age=300",
      "x-tool-registry-copy": stale ? "stale" : "fresh",
      "x-tool-registry-fetched-at": String(row.fetched_at ?? ""),
    },
  });
}

const unavailable = (why: string, status = 502) => json({ error: why }, { status });

/** Fetch one file of a registry from its host, within the caps; the text, or why not. */
async function fetchUpstream(
  env: Env,
  reg: ToolRegistryEntry,
  url: string,
  kind: FileKind,
): Promise<{ text: string } | { error: string }> {
  let res: Response;
  try {
    res = await toolFetch(env, url, {
      credentials: "omit",
      headers: { accept: kind === "script" ? "text/javascript, text/plain, */*" : "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: e instanceof ToolFetchRefused ? e.message : "its host is unreachable from this instance" };
  }
  if (!res.ok) return { error: `its host answered ${res.status}` };
  const cap = REGISTRY_FILE_CAP[kind];
  const bytes = await readCappedBody(res, cap);
  if (!bytes) return { error: `it is larger than ${Math.round(cap / 1024)} KB` };
  const others = await env.DB.prepare(
    "SELECT COALESCE(SUM(bytes), 0) AS n FROM tool_registry_files WHERE registry_id=? AND url != ?",
  )
    .bind(reg.id, url)
    .first<{ n: number }>();
  if ((others?.n ?? 0) + bytes.byteLength > REGISTRY_TOTAL_CAP)
    return { error: `the registry's files pass ${REGISTRY_TOTAL_CAP / 1024 / 1024} MB together` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: "it is not UTF-8 text" };
  }
  if (kind !== "script" && parseJson(text) === null) return { error: "it is not JSON" };
  return { text };
}

/** GET /api/tools/registries/:id/file?url=… */
async function handleFile(req: Request, env: Env, id: string): Promise<Response> {
  if (!proxyOn(env))
    return unavailable("this instance does not fetch tool registries; fetch the registry directly", 404);
  if (rateLimited(`toolreg-file:${env.INSTANCE ?? ""}:${clientIp(req, env)}`, Date.now(), FILE_REQUESTS_PER_MIN))
    return json({ error: "too many registry file requests: try again in a minute" }, { status: 429 });
  const target = httpsUrl(new URL(req.url).searchParams.get("url") ?? "");
  if (!target) return json({ error: "url must be an https address" }, { status: 400 });
  // find the registry: the instance's, or the signed-in player's own while players may add registries
  let reg = (await instanceRegistries(env)).registries.find((e) => e.id === id && e.enabled);
  let accountId: string | null = null;
  if (!reg) {
    const me = await sessionIdentity(req, env);
    if (me && playersMayAdd(env)) {
      reg = (await accountRegistries(env, me.accountId)).find((e) => e.id === id && e.enabled);
      accountId = me.accountId;
    }
  }
  if (!reg || onThisOrigin(reg)) return json({ error: "no such registry" }, { status: 404 });
  const kind = await kindOf(env, reg, target);
  if (!kind) return json({ error: "this file is not one the registry leads to" }, { status: 404 });

  const row = await env.DB.prepare(
    "SELECT url, body, content_type, bytes, fetched_at, tried_at, error FROM tool_registry_files WHERE registry_id=? AND url=?",
  )
    .bind(reg.id, target)
    .first<FileRow>();
  const now = nowS();
  const hasCopy = !!row && row.body !== null;
  if (hasCopy && row.fetched_at !== null && now - row.fetched_at < REGISTRY_COPY_TTL_S)
    return serveCopy(row, kind, reg, false);
  // a recent failure waits before the next attempt
  if (row && row.error && now - row.tried_at < RETRY_AFTER_FAIL_S)
    return hasCopy ? serveCopy(row, kind, reg, true) : unavailable(`couldn't fetch the file: ${row.error}`);
  if (
    accountId &&
    (await rateLimitedDurable(env, `toolreg-fetch:${accountId}`, Date.now(), PLAYER_FETCHES_PER_HOUR, 3600_000))
  )
    return hasCopy ? serveCopy(row, kind, reg, true) : unavailable("too many registry fetches; try again later", 429);

  const got = await fetchUpstream(env, reg, target, kind);
  if ("error" in got) {
    await env.DB.prepare(
      `INSERT INTO tool_registry_files (registry_id, url, bytes, tried_at, error) VALUES (?,?,0,?,?)
       ON CONFLICT(registry_id, url) DO UPDATE SET tried_at=excluded.tried_at, error=excluded.error`,
    )
      .bind(reg.id, target, now, got.error.slice(0, 200))
      .run();
    return hasCopy
      ? serveCopy({ ...row, error: got.error }, kind, reg, true)
      : unavailable(`couldn't fetch the file: ${got.error}`);
  }
  const bytes = new TextEncoder().encode(got.text).byteLength;
  await env.DB.prepare(
    `INSERT INTO tool_registry_files (registry_id, url, body, content_type, bytes, fetched_at, tried_at, error)
     VALUES (?,?,?,?,?,?,?,NULL)
     ON CONFLICT(registry_id, url) DO UPDATE SET body=excluded.body, content_type=excluded.content_type,
       bytes=excluded.bytes, fetched_at=excluded.fetched_at, tried_at=excluded.tried_at, error=NULL`,
  )
    .bind(reg.id, target, got.text, CONTENT_TYPE[kind], bytes, now, now)
    .run();
  // a registry or manifest body decides what the registry leads to; a script body does not
  if (kind !== "script") forgetLeads(env, reg.id);
  if (kind === "registry") await pruneCopies(env, reg, got.text);
  return serveCopy(
    {
      url: target,
      body: got.text,
      content_type: CONTENT_TYPE[kind],
      bytes,
      fetched_at: now,
      tried_at: now,
      error: null,
    },
    kind,
    reg,
    false,
  );
}

/**
 * GET /api/tools/registries/preview?spec=… — the registry file at an address someone is about to add, fetched
 * once and kept nowhere, so the person can compare its key's fingerprint before pinning it. For the sysop, and
 * for a signed-in player while players may add registries (counted against the player's fetches).
 */
async function handlePreview(req: Request, env: Env): Promise<Response> {
  if (!proxyOn(env))
    return unavailable("this instance does not fetch tool registries; fetch the registry directly", 404);
  const sysop = (await requireSysop(req, env, { allowOperatorSecret: true })) === null;
  const me = await sessionIdentity(req, env);
  if (!sysop) {
    if (!me) return json({ error: "sign in" }, { status: 401 });
    if (!playersMayAdd(env))
      return json({ error: "this instance does not let players add tool registries" }, { status: 403 });
  }
  const where = registrySourceUrl(new URL(req.url).searchParams.get("spec"));
  if ("error" in where) return json({ error: where.error }, { status: 400 });
  const limiter = `toolreg-fetch:${me?.accountId ?? "operator"}`;
  if (await rateLimitedDurable(env, limiter, Date.now(), PLAYER_FETCHES_PER_HOUR, 3600_000))
    return unavailable("too many registry fetches; try again later", 429);
  const probe: ToolRegistryEntry = {
    ...BUILTIN_TOOL_REGISTRY,
    id: "",
    scope: "instance",
    spec: where.spec,
    url: where.url,
    enabled: true,
  };
  const got = await fetchUpstream(env, probe, where.url, "registry");
  if ("error" in got) return unavailable(`couldn't fetch the registry: ${got.error}`);
  return new Response(got.text, {
    headers: {
      "content-type": CONTENT_TYPE.registry,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-tool-registry-url": where.url,
    },
  });
}

/** /api/tools/registries[/preview|/:id/file] — the effective list, a look before adding, and the carrier. */
export async function handleToolRegistries(req: Request, env: Env, rest: string): Promise<Response> {
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  await loadSiteSettings(env);
  if (rest === "") return handleEffective(req, env);
  if (rest === "/preview") return handlePreview(req, env);
  const file = /^\/([A-Za-z0-9_-]{1,64})\/file$/.exec(rest);
  if (file) return handleFile(req, env, file[1]!);
  return json({ error: "not found" }, { status: 404 });
}

// ---- the account's data ----

/** A player's own registries, for the account export. */
export async function exportAccountRegistries(env: Env, accountId: string): Promise<Record<string, unknown>[]> {
  return (
    await env.DB.prepare(
      "SELECT spec, url, authority, label, enabled, created_at, confirmed_at FROM tool_registries WHERE account_id=? ORDER BY created_at",
    )
      .bind(accountId)
      .all<Record<string, unknown>>()
  ).results;
}

/** Erase a player's own registries and the copies fetched for them. */
export function eraseAccountRegistries(env: Env, accountId: string) {
  return [
    env.DB.prepare(
      "DELETE FROM tool_registry_files WHERE registry_id IN (SELECT id FROM tool_registries WHERE account_id=?)",
    ).bind(accountId),
    env.DB.prepare("DELETE FROM tool_registries WHERE account_id=?").bind(accountId),
  ];
}
