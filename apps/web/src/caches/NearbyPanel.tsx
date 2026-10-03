// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type CSSProperties } from "react";
import { useFmt, useTheme } from "../format.js";
import { typeMeta, typeGlyph } from "../cacheTypes.js";
import { haversine, bearing8, maidenhead, boxAround } from "../map/geo.js";
import { Panel, EmptyState, ErrorState, Icon, Badge, Button, Segmented } from "../ui/index.js";
import { listAdoptions, type AdoptionListing, type BBox, type MapCache, type StationSummary } from "../api.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { GLANCE_MAX_AGE_MS, isFresh, lastFix, type DeviceFix } from "../geo/location.js";
import { LocateStatus, useLocate } from "../geo/useLocate.js";

type Filter = "all" | "caches" | "stations" | "adopt";

/** How far around you Nearby looks when you are off the map's view, in kilometres. */
const AROUND_KM = 10;

/** The device's last reading, while it is recent enough to stand for where you are. */
const recentFix = (): DeviceFix | null => {
  const f = lastFix();
  return f && isFresh(f, GLANCE_MAX_AGE_MS) ? f : null;
};

/**
 * Caches the sysop has offered for adoption, instance-wide and nearest first. Most are archived, so they
 * are off the map; the card opens the cache, where a signed-in holder of a verified call can ask for it.
 */
function AdoptionList(props: {
  dist: (m: { lat: number | null; lon: number | null }) => number;
  selectedId: number | null;
  onPick: (id: number) => void;
}) {
  const fmt = useFmt();
  const phosphor = useTheme() === "phosphor";
  const [rows, setRows] = useState<AdoptionListing[] | null>(null);
  const [err, setErr] = useState(false);
  const load = () => {
    setErr(false);
    listAdoptions()
      .then((r) => setRows(r.adoptions))
      .catch(() => setErr(true));
  };
  useEffect(load, []);
  if (err) return <ErrorState onRetry={load}>Couldn&apos;t load the caches up for adoption.</ErrorState>;
  if (!rows)
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  const sorted = [...rows].sort((a, b) => props.dist(a) - props.dist(b));
  return (
    <>
      <div className="ulabel cardsec">Up for adoption · {sorted.length}</div>
      {sorted.length === 0 ? (
        <EmptyState>No cache is up for adoption on this instance.</EmptyState>
      ) : (
        <ul className="cardlist">
          {sorted.map((a) => {
            const meta = typeMeta(a.type);
            const d = props.dist(a);
            return (
              <li key={a.cacheId}>
                <Button
                  className={`ccard${a.cacheId === props.selectedId ? " active" : ""}`}
                  onClick={() => props.onPick(a.cacheId)}
                >
                  <span className="ccard-ico" data-ctype={a.type}>
                    {typeGlyph(meta, phosphor)}
                  </span>
                  <span className="ccard-b">
                    <span className="ccard-name">{a.title}</span>
                    <span className="ccard-sub">
                      <span className="mono">{a.code}</span> · {a.note}
                    </span>
                    <span className="ccard-meta">
                      <Badge>{a.status}</Badge>
                      <span className="ccard-dist">{d === Infinity ? "" : fmt.distance(d)}</span>
                    </span>
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * Nearby — caches (operator cards) + live stations, nearest first. Distances run from you when the device has
 * a recent reading (the map's locate button, or any reading in the last five minutes), and from the map
 * centre otherwise; asking for a reading is the cacher's tap, never the panel's opening. The map loads only
 * what is in view, so when you are off it the panel fetches what lies around you itself.
 */
export function NearbyPanel(props: {
  caches: MapCache[];
  stations: StationSummary[];
  selectedId: number | null;
  onPick: (id: number) => void;
  onClose: () => void;
  onOffline: () => void;
  /** Caches (the map's filters applied) and live stations in a box, for when you are off the map's view. */
  around: (bbox: BBox) => Promise<{ caches: MapCache[]; stations: StationSummary[] }>;
}) {
  const { map } = usePlatform();
  const fmt = useFmt();
  const phosphor = useTheme() === "phosphor";
  const [filter, setFilter] = useState<Filter>("all");
  const loc = useLocate();
  const [fix, setFix] = useState<DeviceFix | null>(recentFix);
  // a newer reading (the locate button follows you) moves the origin along with the list
  const latest = recentFix();
  const you = latest && (!fix || latest.at > fix.at) ? latest : fix;
  const c = map?.getCenter();
  const here = you ? { lat: you.lat, lon: you.lon } : c ? { lat: c.lat, lon: c.lng } : null;
  const offView = !!you && !!map && !map.getBounds().contains([you.lon, you.lat]);
  const [aroundYou, setAroundYou] = useState<{ caches: MapCache[]; stations: StationSummary[] } | null>(null);
  const [aroundErr, setAroundErr] = useState(false);
  const { around } = props;
  const youLat = you?.lat,
    youLon = you?.lon;
  useEffect(() => {
    if (!offView || youLat == null || youLon == null) {
      setAroundYou(null);
      return;
    }
    let live = true;
    setAroundErr(false);
    around(boxAround(youLat, youLon, AROUND_KM))
      .then((r) => live && setAroundYou(r))
      .catch(() => live && setAroundErr(true));
    return () => {
      live = false;
    };
  }, [offView, youLat, youLon, around]);
  const source = offView ? (aroundYou ?? { caches: [], stations: [] }) : props;
  async function locateMe() {
    const got = await loc.locate(GLANCE_MAX_AGE_MS);
    if ("fix" in got) setFix(got.fix);
  }
  const grid = here ? maidenhead(here.lat, here.lon, 10) : null;
  const dist = (m: { lat: number | null; lon: number | null }) =>
    here && m.lat != null && m.lon != null ? haversine(here.lat, here.lon, m.lat, m.lon) : Infinity;
  const caches = [...source.caches]
    .filter((m) => m.lat != null && m.lon != null)
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, 100);
  const stations = [...source.stations]
    .filter((s) => s.lat != null && s.lon != null)
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, 60);
  const showCaches = filter === "all" || filter === "caches";
  const showStations = filter === "all" || filter === "stations";
  return (
    <Panel title="Nearby" onClose={props.onClose}>
      <div className="nearby-h">
        <span className="muted">nearest first · {you ? "from you" : "from map centre"}</span>
        {grid && <span className="nearby-grid">{grid}</span>}
        {!you && (
          <Button className="fine" disabled={!!loc.waiting} onClick={() => void locateMe()}>
            <Icon name="navigation" size={15} /> Use my location
          </Button>
        )}
        <Button
          className="fine"
          title="Offline packs: caches, details and images for a trip without signal"
          onClick={props.onOffline}
        >
          Offline packs
        </Button>
      </div>
      <LocateStatus waiting={loc.waiting} problem={loc.problem} onCancel={loc.cancel} />
      {offView && aroundErr && <ErrorState>Couldn&apos;t load what is around you.</ErrorState>}
      <Segmented
        label="Show"
        look="chips"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All" },
          { value: "caches", label: "Caches" },
          { value: "stations", label: "Stations" },
          { value: "adopt", label: "For adoption", title: "Caches whose owners are handing them on" },
        ]}
      />

      {filter === "adopt" && <AdoptionList dist={dist} selectedId={props.selectedId} onPick={props.onPick} />}

      {showCaches && (
        <>
          <div className="ulabel cardsec">Caches · {caches.length}</div>
          {caches.length === 0 ? (
            <EmptyState>
              {offView
                ? aroundYou
                  ? `No caches within ${AROUND_KM} km of you.`
                  : "Loading what is around you…"
                : "No caches in view — pan or zoom the map."}
            </EmptyState>
          ) : (
            <ul className="cardlist">
              {caches.map((m) => {
                const meta = typeMeta(m.type);
                const d = dist(m);
                const src = m.source === "native" ? "APRScaching" : (m.sourceName ?? m.source);
                return (
                  <li key={m.globalId}>
                    <Button
                      className={`ccard${m.id === props.selectedId ? " active" : ""}`}
                      disabled={m.id == null}
                      onClick={() => m.id != null && props.onPick(m.id)}
                    >
                      <span className="ccard-ico" data-ctype={m.type}>
                        {typeGlyph(meta, phosphor)}
                      </span>
                      <span className="ccard-b">
                        <span className="ccard-name">{m.title}</span>
                        <span className="ccard-sub">
                          {m.code} · {src}
                        </span>
                        <span className="ccard-meta">
                          <span className="dtpill">
                            D{m.difficulty}/T{m.terrain}
                          </span>
                          <span className="ccard-dist">
                            {d === Infinity
                              ? ""
                              : `${fmt.distance(d)} ${here && m.lat != null && m.lon != null ? bearing8(here.lat, here.lon, m.lat, m.lon) : ""}`}
                          </span>
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {showStations && (
        <>
          <div className="ulabel cardsec top">Live stations · {stations.length}</div>
          {stations.length === 0 ? (
            <EmptyState>No live stations — enable Live stations under Search & filter.</EmptyState>
          ) : (
            stations.map((s) => (
              <div key={s.callsign} className="srow">
                <Icon
                  name="navigation"
                  size={18}
                  className="tcol B heading-ic"
                  style={{ "--course": `${s.course ?? 0}deg` } as CSSProperties}
                />
                <div className="srow-b">
                  <div className="srow-call">{s.callsign}</div>
                  <div className="srow-sub">
                    {s.symbol ?? "—"}
                    {s.speedKn ? ` · ${fmt.speed(s.speedKn)}` : ""}
                  </div>
                </div>
                <div className="srow-heard">{fmt.ago(s.lastSeen)}</div>
              </div>
            ))
          )}
        </>
      )}
    </Panel>
  );
}
