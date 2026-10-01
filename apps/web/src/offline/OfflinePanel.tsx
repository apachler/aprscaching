// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline — the packs a hunter takes on a trip without signal. Two groups: the user's packs (age, size,
 * refresh, delete) and a new pack: an area (the map view, a circle around the map centre, or a corridor
 * along a GPX route), optional type filters, then "Check size" — the pack's data comes first and says what
 * images would add — and Download. The browser is asked to keep the data the first time.
 */
import { useEffect, useRef, useState } from "react";
import {
  PACK_MAX_CORRIDOR_M,
  PACK_MAX_RADIUS_M,
  PACK_MAX_SPAN_DEG,
  PACK_MIN_CORRIDOR_M,
  type CacheType,
  type PackArea,
  type PackResponse,
} from "@aprscaching/shared";
import { API_BASE, offlineReady } from "../api.js";
import { useFmt } from "../format.js";
import { TYPE_META, TYPE_ORDER } from "../cacheTypes.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { Advanced, Badge, Button, EmptyState, Group, Panel, Row, useConfirm, useToast } from "../ui/index.js";
import {
  estimatePack,
  fetchPackData,
  refreshPack,
  storePack,
  type PackEstimate,
  type SaveProgress,
} from "./download.js";
import { routeFromGpx } from "./gpx.js";
import { userPacks } from "./packs.js";
import type { PackMeta } from "./store.js";

/** A pack older than this shows as stale. */
const STALE_DAYS = 7;
const DAY_MS = 86_400_000;

const fetcher = (url: string, init?: RequestInit) => fetch(url, init);
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;

export function OfflinePanel(props: { onClose: () => void }) {
  const [packs, setPacks] = useState<PackMeta[] | null>(null);
  const reload = async () => setPacks(await userPacks(await offlineReady()));
  useEffect(() => {
    void reload();
  }, []);
  const online = typeof navigator === "undefined" || navigator.onLine;
  return (
    <Panel title="Offline" onClose={props.onClose}>
      {!online && (
        <p className="inline-note">No connection: the packs below work, new ones download once you are back online.</p>
      )}
      <Group title="Your packs" status={packs ? `${packs.length}` : "…"}>
        {packs && packs.length === 0 ? (
          <EmptyState>No packs yet. Make one below before a trip without signal.</EmptyState>
        ) : (
          <ul className="packs">
            {packs?.map((p) => (
              <PackRow key={p.id} pack={p} onChanged={reload} />
            ))}
          </ul>
        )}
      </Group>
      <Group title="New pack" status={online ? undefined : "needs a connection"}>
        <NewPack onSaved={reload} disabled={!online} />
      </Group>
      <StorageLine />
    </Panel>
  );
}

function PackRow(props: { pack: PackMeta; onChanged: () => void }) {
  const p = props.pack;
  const fmt = useFmt();
  const toast = useToast();
  const confirm = useConfirm();
  const [progress, setProgress] = useState<SaveProgress | null>(null);
  const stale = Date.now() - p.refreshedAt > STALE_DAYS * DAY_MS;
  const refresh = async () => {
    setProgress({ done: 0, total: 0 });
    try {
      const r = await refreshPack(await offlineReady(), fetcher, API_BASE, p, Date.now(), { onProgress: setProgress });
      toast(r.changed ? `${p.name} updated` : `${p.name} is up to date`);
      props.onChanged();
    } catch (e) {
      toast(`Couldn't refresh ${p.name}: ${(e as Error).message}`);
    } finally {
      setProgress(null);
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: "Delete this pack?",
        message: `${p.name} and its images leave this device.`,
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    await (await offlineReady()).deletePack(p.id);
    props.onChanged();
  };
  return (
    <li className="pack">
      <div className="row">
        <strong>{p.name}</strong>
        {stale && <Badge kind="warn">{Math.floor((Date.now() - p.refreshedAt) / DAY_MS)} days old</Badge>}
      </div>
      <div className="muted fine">
        {p.cacheCount} caches · {mb(p.sizeBytes)} ·{" "}
        {p.images === "none" ? "no images" : p.images === "thumbs" ? "thumbnails" : "full images"} · refreshed{" "}
        {fmt.ago(Math.floor(p.refreshedAt / 1000))}
      </div>
      {progress ? (
        <progress max={progress.total || 1} value={progress.done} aria-label={`Refreshing ${p.name}`} />
      ) : (
        <div className="row">
          <Button onClick={() => void refresh()} disabled={!navigator.onLine}>
            Refresh
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}

type AreaKind = "view" | "circle" | "route";

function NewPack(props: { onSaved: () => void; disabled: boolean }) {
  const { map } = usePlatform();
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AreaKind>("view");
  const [radiusKm, setRadiusKm] = useState(10);
  const [route, setRoute] = useState<[number, number][] | null>(null);
  const [routeErr, setRouteErr] = useState<string | null>(null);
  const [corridorM, setCorridorM] = useState(1000);
  const [types, setTypes] = useState<CacheType[]>([]);
  const [data, setData] = useState<{ area: PackArea; data: PackResponse; est: PackEstimate } | null>(null);
  const [images, setImages] = useState<PackMeta["images"]>("thumbs");
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [progress, setProgress] = useState<SaveProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // the area as the map shows it now, read when the size is checked
  const areaNow = (): PackArea | string => {
    if (kind === "route") return route ? { kind: "route", points: route, corridorM } : "pick a GPX file with the route";
    if (!map) return "the map is not ready";
    if (kind === "circle") {
      const c = map.getCenter();
      return { kind: "radius", lat: c.lat, lon: c.lng, radiusM: radiusKm * 1000 };
    }
    const b = map.getBounds();
    if (b.getEast() - b.getWest() > PACK_MAX_SPAN_DEG || b.getNorth() - b.getSouth() > PACK_MAX_SPAN_DEG)
      return `zoom in: a pack's box spans at most ${PACK_MAX_SPAN_DEG}° (about ${Math.round(PACK_MAX_SPAN_DEG * 111)} km)`;
    return { kind: "bbox", bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] };
  };

  const check = async () => {
    const area = areaNow();
    if (typeof area === "string") return setErr(area);
    setBusy("check");
    setErr(null);
    try {
      const d = await fetchPackData(fetcher, API_BASE, area, { types });
      if (d === "unchanged") return;
      setData({ area, data: d, est: estimatePack(d) });
      if (!estimatePack(d).fullFits && images === "full") setImages("thumbs");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!data) return;
    setBusy("save");
    abort.current = new AbortController();
    try {
      const store = await offlineReady();
      const first = (await userPacks(store)).length === 0;
      const now = Date.now();
      await storePack(
        store,
        fetcher,
        API_BASE,
        {
          id: `pack-${now.toString(36)}`,
          name: name.trim() || defaultName(data.area),
          area: data.area,
          filters: { types },
          images,
          createdAt: now,
          refreshedAt: now,
        },
        data.data,
        { onProgress: setProgress, signal: abort.current.signal },
      );
      if (first && navigator.storage?.persist) {
        const kept = await navigator.storage.persist().catch(() => false);
        toast(kept ? "Pack saved; the browser keeps it" : "Pack saved; the browser may clear it when space runs low");
      } else toast("Pack saved");
      setData(null);
      setName("");
      props.onSaved();
    } catch (e) {
      setErr(
        (e as Error).name === "AbortError" ? "The download was stopped; nothing was saved." : (e as Error).message,
      );
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const est = data?.est;
  return (
    <div className="newpack">
      <Row label="Area">
        <div className="seg" role="group" aria-label="Pack area">
          {(
            [
              ["view", "This map view"],
              ["circle", "Around the map centre"],
              ["route", "Along a route"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={kind === k ? "on" : ""}
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                setData(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </Row>
      {kind === "view" && <p className="muted fine">Pan and zoom the map to the area, then check its size.</p>}
      {kind === "circle" && (
        <label className="slider">
          Radius {radiusKm} km
          <input
            type="range"
            min={1}
            max={PACK_MAX_RADIUS_M / 1000}
            value={radiusKm}
            onChange={(e) => {
              setRadiusKm(+e.target.value);
              setData(null);
            }}
          />
        </label>
      )}
      {kind === "route" && (
        <>
          <label className="fine">
            GPX file (a track or a route)
            <input
              type="file"
              accept=".gpx,application/gpx+xml"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const r = routeFromGpx(await f.text());
                setRoute(typeof r === "string" ? null : r);
                setRouteErr(typeof r === "string" ? r : null);
                setData(null);
              }}
            />
          </label>
          {routeErr && <p className="inline-note bad">{routeErr}</p>}
          {route && <p className="muted fine">{route.length} route points</p>}
          <label className="slider">
            Corridor {corridorM >= 1000 ? `${corridorM / 1000} km` : `${corridorM} m`} each side
            <input
              type="range"
              min={PACK_MIN_CORRIDOR_M}
              max={PACK_MAX_CORRIDOR_M}
              step={100}
              value={corridorM}
              onChange={(e) => {
                setCorridorM(+e.target.value);
                setData(null);
              }}
            />
          </label>
        </>
      )}
      <Advanced label="Only some cache types">
        <div className="pack-types">
          {TYPE_ORDER.map((t) => (
            <label key={t}>
              <input
                type="checkbox"
                checked={types.includes(t)}
                onChange={(e) => {
                  setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t));
                  setData(null);
                }}
              />{" "}
              {TYPE_META[t].label}
            </label>
          ))}
          <p className="muted fine">None ticked: every type.</p>
        </div>
      </Advanced>
      {err && <p className="inline-note bad">{err}</p>}
      {!data ? (
        <Button
          variant="primary"
          onClick={() => void check()}
          disabled={props.disabled || busy != null || (kind === "route" && !route)}
        >
          {busy === "check" ? "Checking…" : "Check size"}
        </Button>
      ) : (
        <div className="pack-estimate">
          <p>
            <strong>{est!.caches}</strong> caches, {mb(est!.dataBytes)} of data.
          </p>
          <fieldset>
            <legend>Images</legend>
            <label>
              <input type="radio" name="images" checked={images === "none"} onChange={() => setImages("none")} /> None
            </label>
            <label>
              <input type="radio" name="images" checked={images === "thumbs"} onChange={() => setImages("thumbs")} /> A
              thumbnail per cache: {mb(est!.thumbsDownload)} to download, about {mb(est!.thumbsStored)} kept
            </label>
            <label>
              <input
                type="radio"
                name="images"
                checked={images === "full"}
                disabled={!est!.fullFits}
                onChange={() => setImages("full")}
              />{" "}
              Every image: {mb(est!.fullBytes)}
              {!est!.fullFits && " — more than a pack holds"}
            </label>
          </fieldset>
          <label>
            Name
            <input value={name} placeholder={defaultName(data.area)} onChange={(e) => setName(e.target.value)} />
          </label>
          {progress ? (
            <div className="row">
              <progress max={progress.total || 1} value={progress.done} aria-label="Downloading images" />
              <Button onClick={() => abort.current?.abort()}>Stop</Button>
            </div>
          ) : (
            <div className="row">
              <Button variant="primary" onClick={() => void save()} disabled={busy != null}>
                Download
              </Button>
              <Button variant="link" onClick={() => setData(null)}>
                Change the area
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function defaultName(area: PackArea): string {
  if (area.kind === "radius")
    return `${Math.round(area.radiusM / 1000)} km around ${area.lat.toFixed(2)}, ${area.lon.toFixed(2)}`;
  if (area.kind === "route") return `Route, ${area.points.length} points`;
  const [w, s, e, n] = area.bbox;
  return `Area ${((s + n) / 2).toFixed(2)}, ${((w + e) / 2).toFixed(2)}`;
}

/** How much the browser grants this site, and how much is used. */
function StorageLine() {
  const [s, setS] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null);
  useEffect(() => {
    void (async () => {
      if (!navigator.storage?.estimate) return;
      const e = await navigator.storage.estimate();
      const persisted = (await navigator.storage.persisted?.().catch(() => false)) ?? false;
      setS({ usage: e.usage ?? 0, quota: e.quota ?? 0, persisted });
    })();
  }, []);
  if (!s) return null;
  return (
    <p className="muted fine">
      Storage: {mb(s.usage)} of {mb(s.quota)} used.{" "}
      {s.persisted
        ? "The browser keeps it."
        : "The browser may clear it when space runs low; adding the app to the home screen helps."}
    </p>
  );
}
