// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline — the packs a hunter takes on a trip without signal. Two groups: the user's packs (age, size,
 * refresh, delete) and a new pack: a Maidenhead locator square (typed, or the field, square, subsquare or
 * extended square at the map centre, outlined on the map), optional type filters, then "Check size" — the
 * pack's data comes first and says what images would add — and Download. The browser is asked to keep the
 * data the first time.
 */
import { useEffect, useRef, useState } from "react";
import { locatorBounds, normalizeLocator, type CacheType, type PackArea, type PackResponse } from "@aprscaching/shared";
import type * as maplibregl from "maplibre-gl";
import { maidenhead } from "../map/geo.js";
import { API_BASE, ensureDeviceKey, offlineReady } from "../api.js";
import { useFmt } from "../format.js";
import { TYPE_META, FILTER_TYPES } from "../cacheTypes.js";
import { usePlatform } from "../platform/PlatformContext.js";
import {
  Advanced,
  Badge,
  Button,
  Disclosure,
  EmptyState,
  Group,
  Panel,
  Row,
  Switch,
  useConfirm,
  useToast,
} from "../ui/index.js";
import { TERMS } from "../terms.js";
import { mobileDataAllowed, setMobileDataAllowed } from "./sync.js";
import {
  estimatePack,
  fetchPackData,
  refreshPack,
  storePack,
  type PackEstimate,
  type SaveProgress,
} from "./download.js";
import { userPacks } from "./packs.js";
import { invalidatePackTiles } from "./packTiles.js";
import { planTiles, tileBudget, type ArchiveInfo, type TileReader, type TilesConfig } from "./tiles.js";
import { PMTiles } from "pmtiles";
import type { PackMeta } from "./store.js";
import { tokenHex } from "../map/mapPaint.js";

/** The instance's offline map, when it offers one: its settings, the archive's header and a tile reader. */
async function offlineMap(): Promise<{ config: TilesConfig; info: ArchiveInfo; reader: TileReader } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/offline/tiles`);
    const config = (await res.json()) as TilesConfig;
    if (!res.ok || !config.url) return null;
    const archive = new PMTiles(/^https?:/.test(config.url) ? config.url : API_BASE + config.url);
    const h = await archive.getHeader();
    return {
      config,
      info: {
        minZoom: h.minZoom,
        maxZoom: h.maxZoom,
        numTileContents: h.numTileContents,
        tileDataLength: h.tileDataLength,
      },
      reader: archive,
    };
  } catch {
    return null;
  }
}

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
      <Group title="Your packs" help={TERMS["offline-pack"]} status={packs ? `${packs.length}` : "…"}>
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
      <Group
        title="New pack"
        help="Pick a locator square; the pack saves its caches, hints, latest logs and, where offered, the map."
        status={online ? undefined : "needs a connection"}
      >
        <NewPack onSaved={reload} disabled={!online} />
      </Group>
      <OwnerPack packs={packs ?? []} onSaved={reload} disabled={!online} />
      <SyncSettings />
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
    invalidatePackTiles();
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
      {p.area && "mine" in p.area && <OwnerAttention packId={p.id} />}
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

/** The caches of the owner's pack that need a visit, and why. */
function OwnerAttention(props: { packId: string }) {
  const [due, setDue] = useState<{ code: string; title: string; why: string[] }[] | null>(null);
  useEffect(() => {
    void (async () => {
      const caches = await (await offlineReady()).packCaches(props.packId);
      setDue(
        caches.filter((c) => c.attention?.length).map((c) => ({ code: c.code, title: c.title, why: c.attention! })),
      );
    })();
  }, [props.packId]);
  if (!due) return null;
  if (!due.length) return <p className="muted fine">None of your caches needs a visit.</p>;
  return (
    <Disclosure label={`${due.length} ${due.length === 1 ? "cache needs" : "caches need"} a visit`}>
      <ul className="pack-attention">
        {due.map((d) => (
          <li key={d.code}>
            <span className="mono">{d.code}</span> {d.title}
            <div className="muted fine">{d.why.join(" · ")}</div>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/**
 * The owner's maintenance pack in one tap: every cache the signed-in owner holds, flagged where a visit is
 * due; maintenance logged in the field waits in the queue like any log. Refreshes the pack when it exists.
 */
function OwnerPack(props: { packs: PackMeta[]; onSaved: () => void; disabled: boolean }) {
  const { callsign } = usePlatform();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!callsign) return null;
  const existing = props.packs.find((p) => p.area && "mine" in p.area);
  const run = async () => {
    setBusy(true);
    void ensureDeviceKey(callsign);
    try {
      const store = await offlineReady();
      if (existing) await refreshPack(store, fetcher, API_BASE, existing, Date.now());
      else {
        const data = await fetchPackData(fetcher, API_BASE, { mine: true }, { types: [] });
        if (data === "unchanged") return;
        const now = Date.now();
        await storePack(
          store,
          fetcher,
          API_BASE,
          {
            id: `mine-${now.toString(36)}`,
            name: "My caches",
            area: { mine: true },
            filters: { types: [] },
            images: "thumbs",
            createdAt: now,
            refreshedAt: now,
          },
          data,
        );
      }
      toast(existing ? "Your caches are up to date" : "Your caches are packed");
      props.onSaved();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title="Your caches" status="owner maintenance" defaultOpen={false}>
      <p className="muted fine">
        Every cache you own, with thumbnails, flagged where a visit is due. Maintenance you log in the field is sent
        when you are back online.
      </p>
      <Button onClick={() => void run()} disabled={props.disabled || busy}>
        {busy ? "Packing…" : existing ? "Refresh my caches" : "Pack my caches"}
      </Button>
    </Group>
  );
}

/** A pack of a locator square (the form's kind; the owner's pack has its own button). */
type SquareArea = Extract<PackArea, { locator: string }>;

/** The four locator sizes, from big to small. */
const SIZES = [
  { chars: 2, label: "Field", example: "JN" },
  { chars: 4, label: "Square", example: "JN77" },
  { chars: 6, label: "Subsquare", example: "JN77sb" },
  { chars: 8, label: "Extended", example: "JN77sb42" },
] as const;

/** "160 × 111 km": a locator square's size on the ground. */
function squareSize(locator: string): string {
  const [w, s, e, n] = locatorBounds(locator);
  const km = (deg: number, atLat = 0) => deg * 111.32 * Math.cos((atLat * Math.PI) / 180);
  const fmt = (v: number) => (v >= 10 ? `${Math.round(v)}` : v >= 1 ? v.toFixed(1) : `${Math.round(v * 1000)} m`);
  const x = km(e - w, (s + n) / 2),
    y = km(n - s);
  return x >= 1 ? `${fmt(x)} × ${fmt(y)} km` : `${fmt(x)} × ${fmt(y)}`;
}

function NewPack(props: { onSaved: () => void; disabled: boolean }) {
  const { map, session, callsign } = usePlatform();
  const toast = useToast();
  const [input, setInput] = useState("");
  const [name, setName] = useState("");
  const [types, setTypes] = useState<CacheType[]>([]);
  const [data, setData] = useState<{ area: SquareArea; data: PackResponse; est: PackEstimate } | null>(null);
  const [images, setImages] = useState<PackMeta["images"]>("thumbs");
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [progress, setProgress] = useState<SaveProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // the instance's offline map, read when the size is checked: its settings, the archive's header, a reader
  const [mapSrc, setMapSrc] = useState<{ config: TilesConfig; info: ArchiveInfo; reader: TileReader } | null>(null);
  const [withMap, setWithMap] = useState(true);
  const locator = normalizeLocator(input);
  useSquareOutline(map, locator);

  /** The square of the given size at the map centre. */
  const fromMap = (chars: number) => {
    const c = map?.getCenter();
    if (!c) return;
    setInput(maidenhead(c.lat, c.lng, chars));
    setData(null);
    setErr(null);
  };

  const check = async () => {
    if (!locator) return setErr("Enter a Maidenhead locator, such as JN77 or JN77sb.");
    const area: SquareArea = { locator };
    setBusy("check");
    setErr(null);
    try {
      const d = await fetchPackData(fetcher, API_BASE, area, { types });
      if (d === "unchanged") return;
      const est = estimatePack(d);
      setData({ area, data: d, est });
      if (!est.fullFits && images === "full") setImages("thumbs");
      setMapSrc(await offlineMap());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!data) return;
    setBusy("save");
    // a find logged from this pack offline is signed with the device key: register it while there is a connection
    if (session.signedIn) void ensureDeviceKey(callsign);
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
          name: name.trim() || data.area.locator,
          area: data.area,
          filters: { types },
          images,
          createdAt: now,
          refreshedAt: now,
        },
        data.data,
        {
          onProgress: setProgress,
          signal: abort.current.signal,
          ...(withMap &&
            mapSrc &&
            plan && { tiles: { reader: mapSrc.reader, plan, attribution: mapSrc.config.attribution } }),
        },
      );
      invalidatePackTiles();
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
  const imageBytes = !est ? 0 : images === "full" ? est.fullBytes : images === "thumbs" ? est.thumbsBytes : 0;
  const plan =
    est && mapSrc && data
      ? planTiles(
          mapSrc.info,
          locatorBounds(data.area.locator),
          mapSrc.config.maxZoom,
          tileBudget(est.dataBytes + imageBytes),
        )
      : null;
  return (
    <div className="newpack">
      <label>
        Maidenhead locator
        <input
          className="mono"
          value={input}
          placeholder="JN77sb"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => {
            setInput(e.target.value);
            setData(null);
          }}
        />
      </label>
      <div className="seg" role="group" aria-label="Take the square at the map centre">
        {SIZES.map((sz) => (
          <Button
            key={sz.chars}
            onClick={() => fromMap(sz.chars)}
            hint={`Save the ${sz.label.toLowerCase()} at the map centre, such as ${sz.example}`}
          >
            {sz.label}
          </Button>
        ))}
      </div>
      <p className="muted fine">
        {locator
          ? `${locator}: ${squareSize(locator)}, outlined on the map.`
          : "Type a locator, or take the field, square, subsquare or extended square at the map centre. A longer locator is a smaller pack."}
      </p>
      <Advanced label="Only some cache types">
        <div className="pack-types">
          {FILTER_TYPES.map((t) => (
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
        <Button variant="primary" onClick={() => void check()} disabled={props.disabled || busy != null || !locator}>
          {busy === "check" ? "Checking…" : "Check size"}
        </Button>
      ) : (
        <div className="pack-estimate">
          <p>
            <strong>{est!.caches}</strong> caches in {data.area.locator}, {mb(est!.dataBytes)} of data.
          </p>
          <fieldset>
            <legend>Images</legend>
            <label>
              <input type="radio" name="images" checked={images === "none"} onChange={() => setImages("none")} /> None
            </label>
            <label>
              <input type="radio" name="images" checked={images === "thumbs"} onChange={() => setImages("thumbs")} /> A
              thumbnail per cache: {mb(est!.thumbsBytes)}
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
          {!mapSrc ? (
            <p className="muted fine">
              This instance offers no offline map: offline, the map shows a grid under the caches.
            </p>
          ) : plan ? (
            <label>
              <input type="checkbox" checked={withMap} onChange={(e) => setWithMap(e.target.checked)} /> The map, zoom{" "}
              {plan.minZoom}–{plan.maxZoom}: about {mb(plan.estBytes)}
              {plan.maxZoom < Math.min(mapSrc.info.maxZoom, mapSrc.config.maxZoom) && " (less detail, to fit the pack)"}
            </label>
          ) : (
            <p className="muted fine">
              The square is too large for its map to fit a pack; take a smaller square for the map.
            </p>
          )}
          <label>
            Name
            <input value={name} placeholder={data.area.locator} onChange={(e) => setName(e.target.value)} />
          </label>
          {progress ? (
            <div className="row">
              <progress
                max={progress.total || 1}
                value={progress.done}
                aria-label={progress.what === "map" ? "Downloading the map" : "Downloading images"}
              />
              <Button onClick={() => abort.current?.abort()}>Stop</Button>
            </div>
          ) : (
            <div className="row">
              <Button variant="primary" onClick={() => void save()} disabled={busy != null}>
                Download
              </Button>
              <Button variant="quiet" onClick={() => setData(null)}>
                Change the locator
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const OUTLINE = "acs-pack-square";

/** Outline the locator square on the map while it is being chosen; removed with the panel. */
function useSquareOutline(map: maplibregl.Map | null, locator: string | null) {
  useEffect(() => {
    if (!map) return;
    const clear = () => {
      try {
        if (map.getLayer(OUTLINE)) map.removeLayer(OUTLINE);
        if (map.getSource(OUTLINE)) map.removeSource(OUTLINE);
      } catch {
        /* the style was replaced meanwhile */
      }
    };
    clear();
    if (!locator) return clear;
    const [w, s, e, n] = locatorBounds(locator);
    try {
      map.addSource(OUTLINE, {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          },
        },
      });
      // a literal colour: MapLibre paints into the GPU canvas and cannot read CSS tokens
      map.addLayer({
        id: OUTLINE,
        type: "line",
        source: OUTLINE,
        paint: { "line-color": tokenHex("--map-ring"), "line-width": 2, "line-dasharray": [2, 1] },
      });
    } catch {
      /* the style is still loading: no outline this time */
    }
    return clear;
  }, [map, locator]);
}

/** When packs refresh on their own: on Wi-Fi or Ethernet, or on mobile data too if allowed. */
function SyncSettings() {
  const [mobile, setMobile] = useState(mobileDataAllowed);
  return (
    <Group title="Sync" status={mobile ? "any connection" : "Wi-Fi only"} defaultOpen={false}>
      <Row
        label="Refresh packs on mobile data"
        help="Packs older than a day refresh on their own on Wi-Fi; Sync now refreshes them on any connection"
      >
        <Switch
          label="Refresh packs on mobile data"
          checked={mobile}
          onChange={(v) => {
            setMobileDataAllowed(v);
            setMobile(v);
          }}
        />
      </Row>
      <p className="muted fine">
        Logs made offline go as soon as the connection returns. With the app closed, Chrome and Edge send them in the
        background; Safari and Firefox send them when you next open the app.
      </p>
    </Group>
  );
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
