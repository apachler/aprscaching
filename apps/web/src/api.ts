import type {
  CacheSummary, CacheDetail, CreateCacheRequest, UpdateCacheRequest,
  MapCache, LogType, AppGeo, TrustTier,
} from "@aprsweb/shared";

export type { CacheSummary, CacheDetail, CreateCacheRequest, MapCache, LogType, AppGeo, TrustTier };

/** Worker base URL. In dev the Worker runs on :8787; in prod set VITE_API_BASE to api.aprscaching.com. */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://127.0.0.1:8787";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export function listCaches(bbox: BBox): Promise<{ caches: MapCache[] }> {
  return call(`/api/caches?bbox=${bbox.join(",")}`);
}

export function getCache(id: number): Promise<{ cache: CacheDetail }> {
  return call(`/api/caches/${id}`);
}

export function createCache(body: CreateCacheRequest): Promise<{ cache: CacheSummary }> {
  return call(`/api/caches`, { method: "POST", body: JSON.stringify(body) });
}

export function updateCache(id: number, body: UpdateCacheRequest): Promise<{ cache: CacheSummary }> {
  return call(`/api/caches/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export interface LogResult {
  logged: boolean;
  logType: LogType;
  accountVerified: boolean;
  verified: boolean;
  tier?: TrustTier;
  method?: string;
  distanceM?: number;
  reason?: string;
  announced?: boolean;
}

export function logFind(
  cacheId: number,
  body: { loggerCall: string; logType: LogType; comment?: string; appGeo?: AppGeo },
): Promise<LogResult> {
  return call(`/api/caches/${cacheId}/logs`, { method: "POST", body: JSON.stringify(body) });
}
