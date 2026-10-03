// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type CSSProperties } from "react";
import {
  toggleFavorite,
  rateCache,
  getCacheLogs,
  cacheShareUrl,
  cacheQrUrl,
  getCacheAdoption,
  requestAdoption,
  cancelAdoptionRequest,
  keepCache,
  type CacheAdoptionState,
  type CacheDetail,
  type CacheRating,
  type Spot,
} from "../api.js";
import type { CacheLogEntry } from "@aprscaching/shared";
import { typeMeta, typeGlyph } from "../cacheTypes.js";
import { useFmt, useTheme } from "../format.js";
import { maidenhead, haversine } from "../map/geo.js";
import { GLANCE_MAX_AGE_MS, isFresh, lastFix, locationSupport, requestFix } from "../geo/location.js";
import {
  Button,
  Panel,
  Badge,
  Icon,
  TierChip,
  MinTier,
  Disclosure,
  TIER_NAME,
  DtBars,
  Stat,
  LoadMore,
  useToast,
  useConfirm,
  copyText,
  type Tier,
} from "../ui/index.js";
import { StagesSection } from "../log/StagesSection.js";
import { LogForm } from "../log/LogForm.js";
import { NavigateCache } from "./NavigateCache.js";
import { CacheMedia } from "./CacheMedia.js";
import { EditCachePanel } from "./EditCachePanel.js";
import { usePlatform } from "../platform/PlatformContext.js";
import type { OfflineFrom } from "../api.js";
import { syncNote } from "../log/syncNote.js";
import { TermHelp } from "../platform/TermHelp.js";

/** A point on the globe. */
type LatLon = { lat: number; lon: number };

/**
 * Where the viewer is, when that is already known: the map's locate control, a recent reading, or —
 * only when location permission was granted before — a new one. It never prompts; an unknown position
 * shows nothing.
 */
function useKnownPosition(from: LatLon | null | undefined): LatLon | null {
  const [pos, setPos] = useState<LatLon | null>(null);
  useEffect(() => {
    if (from) return;
    const known = lastFix();
    if (known && isFresh(known, GLANCE_MAX_AGE_MS)) {
      setPos({ lat: known.lat, lon: known.lon });
      return;
    }
    if (locationSupport() || !navigator.permissions) return;
    const ac = new AbortController();
    navigator.permissions
      .query({ name: "geolocation" })
      .then((p) => (p.state === "granted" ? requestFix({ maxAgeMs: GLANCE_MAX_AGE_MS, signal: ac.signal }) : null))
      .then((g) => g && !ac.signal.aborted && setPos({ lat: g.lat, lon: g.lon }))
      .catch(() => {});
    return () => ac.abort();
  }, [from]);
  return from ?? pos;
}

/** Cache detail + logbook — operator layout; single primary action (Log a find). */
/** The base call of a callsign, without its SSID: an owner operating OE8APR-7 is the owner of OE8APR's cache. */
const baseOf = (cs: string) => cs.toUpperCase().split("-")[0] ?? "";

export function DetailPanel(props: {
  detail: CacheDetail;
  /** The viewer's position, when the map already knows it. */
  here?: LatLon | null;
  activating?: Spot | null;
  /** The offline pack this page was read from, when there is no connection. */
  offlineFrom?: OfflineFrom | null;
  onClose: () => void;
  onLogged: () => void;
  onSignIn: () => void;
}) {
  const { callsign } = usePlatform();
  const c = props.detail;
  const meta = typeMeta(c.type);
  const fmt = useFmt();
  const phosphor = useTheme() === "phosphor";
  const toast = useToast();
  const [fav, setFav] = useState({ on: c.favorited, count: c.favorites });
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [c.id]);
  useEffect(() => {
    setFav({ on: c.favorited, count: c.favorites });
  }, [c.id, c.favorited, c.favorites]);
  // logbook paging: detail embeds the first page; older entries load on demand
  const [moreLogs, setMoreLogs] = useState<CacheLogEntry[]>([]);
  const [logCursor, setLogCursor] = useState<string | null>(c.logsCursor ?? null);
  const [logsMore, setLogsMore] = useState<boolean>(!!c.logsHasMore);
  const [logsLoading, setLogsLoading] = useState(false);
  useEffect(() => {
    setMoreLogs([]);
    setLogCursor(c.logsCursor ?? null);
    setLogsMore(!!c.logsHasMore);
  }, [c.id, c.logsCursor, c.logsHasMore]);
  async function loadMoreLogs() {
    if (!logCursor || logsLoading) return;
    setLogsLoading(true);
    try {
      const r = await getCacheLogs(c.id, logCursor);
      setMoreLogs((m) => [...m, ...r.logs]);
      setLogCursor(r.nextCursor);
      setLogsMore(r.hasMore);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLogsLoading(false);
    }
  }
  async function toggleFav() {
    if (callsign.length < 3) return;
    const want = !fav.on;
    setFav((f) => ({ on: want, count: f.count + (want ? 1 : -1) })); // optimistic
    try {
      const r = await toggleFavorite(c.id, callsign, want);
      setFav(r);
    } catch (e) {
      setFav({ on: c.favorited, count: c.favorites });
      toast((e as Error).message);
    }
  }
  const minTier: Tier = c.minTrust ?? "B"; // the site default minimum is B
  const here = useKnownPosition(props.here);
  const away = here && c.lat != null && c.lon != null ? haversine(here.lat, here.lon, c.lat, c.lon) : null;
  const grid = c.lat != null && c.lon != null ? maidenhead(c.lat, c.lon, 10) : null;
  function copyCoords() {
    if (c.lat == null || c.lon == null) return;
    void copyText(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`).then((ok) =>
      toast(ok ? "Coordinates copied" : "Copy failed — long-press the coordinates to copy"),
    );
  }
  if (editing && c.own)
    return (
      <EditCachePanel
        detail={c}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          props.onLogged();
        }}
      />
    );
  return (
    <Panel
      onClose={props.onClose}
      title={c.title}
      actions={
        <>
          {c.own && !props.offlineFrom && (
            <Button title={`Edit ${c.code}`} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button className={`heart${fav.on ? " on" : ""}`} title="Favorite" onClick={toggleFav}>
            {fav.on ? "♥" : "♡"} {fav.count}
          </Button>
        </>
      }
    >
      {props.offlineFrom && (
        <p className="inline-note" role="status">
          Offline copy from{" "}
          {props.offlineFrom.auto ? "the area you last browsed" : `the pack “${props.offlineFrom.name}”`}, refreshed{" "}
          {fmt.ago(Math.floor(props.offlineFrom.refreshedAt / 1000))}. Finds, favourites and ratings show once you are
          back online; a find you log now is saved and sent then.
        </p>
      )}
      {props.activating && (
        <div className="activating-now" role="status">
          <span className="pulse" aria-hidden="true" /> Being activated now by{" "}
          <strong className="mono">{props.activating.callsign}</strong>
          {props.activating.band ? (
            <span className="muted">
              {" "}
              · {props.activating.band}
              {props.activating.mode ? ` ${props.activating.mode}` : ""}
            </span>
          ) : null}
        </div>
      )}
      <div className="detail-meta">
        <span className="typechip" data-ctype={c.type}>
          {typeGlyph(meta, phosphor)} {meta.label}
        </span>
        <span className="srcchip">
          {c.source === "native" ? "APRScaching" : `imported · ${c.sourceName ?? c.source}`}
        </span>
        <span className="dataval">{c.code}</span>
      </div>
      <p className="muted mt-1">
        by <span className="mono">{c.ownerCall}</span>
        {away != null && (
          <>
            {" · "}
            <span className="cache-away">{fmt.distance(away)} away</span>
          </>
        )}
      </p>
      {c.type === "aprs_living" && c.stationCall && (
        <p className="muted living-station">
          Rides on <span className="mono">{c.stationCall}</span>
          {" · "}
          {c.stationHeardAt
            ? `position from ${fmt.ago(c.stationHeardAt)}`
            : "no position yet: it shows where it was hidden"}
        </p>
      )}

      {(c.driveIn || c.country || c.tags.length > 0) && (
        <div className="badges cache-tags">
          {c.driveIn && (
            <span className="chip">
              <Icon name="car" cp437="" className="lead-ic" />
              Drive-in
            </span>
          )}
          {c.country && <span className="chip">{c.country}</span>}
          {c.tags.map((t) => (
            <span key={t} className="chip">
              #{t}
            </span>
          ))}
        </div>
      )}

      <div className="detail-stats">
        <Stat label="Difficulty">
          <DtBars value={c.difficulty} />
          <div className="mt-2">{c.difficulty.toFixed(1)} / 5</div>
        </Stat>
        <Stat label="Terrain">
          <DtBars value={c.terrain} />
          <div className="mt-2">{c.terrain.toFixed(1)} / 5</div>
        </Stat>
      </div>

      <RatingWidget cacheId={c.id} callsign={callsign} rating={c.rating} onToast={toast} />

      {grid && (
        <div className="coordblock">
          <div className="coordblock-h">
            <span className="ulabel">Coordinates</span>
            <Button variant="icon-subtle" aria-label="Copy coordinates" onClick={copyCoords}>
              <Icon name="copy" size={16} />
            </Button>
          </div>
          <div className="coordblock-g">
            <span className="k">LAT/LON</span>
            <span className="v">
              {c.lat!.toFixed(4)}° · {c.lon!.toFixed(4)}°
            </span>
            <span className="k">GRID</span>
            <span className="v">{grid}</span>
          </div>
          <NavigateCache lat={c.lat!} lon={c.lon!} title={c.title} />
        </div>
      )}

      {c.source !== "native" && c.sourceUrl && (
        <p className="imported">
          ⤓ Imported from <strong>{c.sourceName ?? c.source}</strong> ·{" "}
          <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener">
            view source ↗
          </a>
        </p>
      )}

      <ShareCache code={c.code} title={c.title} onToast={toast} />

      <p>
        <strong>{c.finds}</strong> verified find{c.finds === 1 ? "" : "s"}
        {c.status !== "active" && (
          <>
            {" "}
            · <em>{c.status}</em>
          </>
        )}
        {c.needsMaintenance && <span className="warn"> · ⚠ needs maintenance</span>}
      </p>
      {c.description && <p className="desc">{c.description}</p>}
      {c.hint && (
        <Disclosure label="Hint">
          <p>{c.hint}</p>
        </Disclosure>
      )}
      <Disclosure
        className="cache-verify"
        label={`Verification · ${TIER_NAME[minTier]}${minTier === "B" ? " or better" : ""}`}
      >
        <MinTier tier={minTier} />
        <p className="muted fine">
          Tier A, B and C say how a find was confirmed. <TermHelp term="tier" />
        </p>
      </Disclosure>

      <CacheMedia cacheId={c.id} isOwner={callsign.toUpperCase() === c.ownerCall.toUpperCase()} onToast={toast} />

      {c.source === "native" && <AdoptionSection cacheId={c.id} code={c.code} onSignIn={props.onSignIn} />}

      {c.rendezvous.length > 0 && (
        <div className="rendezvous">
          <span className="ulabel">Rendezvous</span>
          <ul className="rdv-list">
            {c.rendezvous.map((r, i) => (
              <li key={`${r.withCacheId}-${r.ts}-${i}`}>
                <Icon name="handover" cp437="" className="lead-ic" />
                met <span className="mono">{r.withCall}</span>{" "}
                <span className="muted">· {r.day ? fmt.date(r.ts) : fmt.ago(r.ts)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.stageCount > 0 && <StagesSection cacheId={c.id} callsign={callsign} />}

      <LogForm
        cacheId={c.id}
        cacheCode={c.code}
        cacheLat={c.lat ?? null}
        cacheLon={c.lon ?? null}
        callsign={callsign}
        isOwner={!!callsign && baseOf(callsign) === baseOf(c.ownerCall)}
        cacheStatus={c.status}
        onLogged={props.onLogged}
        onSignIn={props.onSignIn}
      />

      {c.findsByMonth && c.findsByMonth.some((m) => m.n > 0) && (
        <div className="findstrend">
          <span className="ulabel">Finds over time</span>
          <div className="sparkline" role="img" aria-label="Verified finds per month">
            {c.findsByMonth.map((m) => {
              const max = Math.max(...c.findsByMonth!.map((x) => x.n), 1);
              return (
                <span
                  key={m.month}
                  className="spark-bar"
                  style={{ "--h": `${Math.max(10, (m.n / max) * 100)}%` } as CSSProperties}
                  title={`${m.month}: ${m.n}`}
                />
              );
            })}
          </div>
        </div>
      )}

      <div className="row between logbook-h">
        <h4 className="m-0">Logbook</h4>
        <span className="ulabel">{c.finds} finds</span>
      </div>
      {c.logs.length === 0 && <p className="muted">No logs yet — be the first to find it.</p>}
      {[...c.logs, ...moreLogs].map((l) => (
        <LogRow
          key={l.id}
          log={l}
          ago={fmt.ago(l.ts)}
          dist={l.distanceM != null ? fmt.distance(l.distanceM) : null}
          sync={syncNote(l, fmt.dateTime)}
        />
      ))}
      <LoadMore hasMore={logsMore} loading={logsLoading} onClick={loadMoreLogs} />
    </Panel>
  );
}

/** Owner-gated 1–5 star rating. Shows the aggregate; lets a permitted caller set/replace theirs. */
function RatingWidget(props: { cacheId: number; callsign: string; rating: CacheRating; onToast: (m: string) => void }) {
  const [r, setR] = useState(props.rating);
  const [hover, setHover] = useState(0);
  useEffect(() => {
    setR(props.rating);
  }, [props.cacheId, props.rating]);
  if (r.policy === "off") return null;
  async function rate(stars: number) {
    if (!r.canRate) return;
    try {
      const res = await rateCache(props.cacheId, stars, props.callsign || undefined);
      setR(res.rating);
      props.onToast(`Rated ${stars}★`);
    } catch (e) {
      props.onToast((e as Error).message);
    }
  }
  const shown = hover || r.mine || 0;
  return (
    <div className="rating">
      <div className="rating-h">
        <span className="ulabel">Rating</span>
        <span className="rating-agg">
          {r.avg != null ? (
            <>
              ★ {r.avg.toFixed(1)} <span className="muted">({r.count})</span>
            </>
          ) : (
            <span className="muted">no ratings yet</span>
          )}
        </span>
      </div>
      {r.canRate ? (
        <div className="rating-stars" role="radiogroup" aria-label="Rate this cache" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((s) => (
            <Button
              key={s}
              type="button"
              role="radio"
              aria-checked={r.mine === s}
              aria-label={`${s} star${s === 1 ? "" : "s"}`}
              className={`star${s <= shown ? " on" : ""}`}
              onMouseEnter={() => setHover(s)}
              onClick={() => rate(s)}
            >
              ★
            </Button>
          ))}
          {r.mine ? <span className="muted fine">your rating</span> : null}
        </div>
      ) : (
        <p className="muted fine">
          {r.policy === "finders" ? "Log a verified find to rate this cache." : "Sign in to rate."}
        </p>
      )}
    </div>
  );
}

/**
 * A cache up for adoption: the sysop's public note and the one action open to the viewer — ask to adopt it
 * (a signed-in holder of a verified call), withdraw that request, or, for the owner, keep the cache.
 * Renders nothing for a cache that is not offered and has no request from the viewer.
 */
function AdoptionSection(props: { cacheId: number; code: string; onSignIn: () => void }) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const [st, setSt] = useState<CacheAdoptionState | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [inPlace, setInPlace] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setLoadErr(false);
    getCacheAdoption(props.cacheId)
      .then(setSt)
      .catch(() => setLoadErr(true));
  };
  useEffect(() => {
    setSt(null);
    setErr(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cacheId]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      toast(done);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const keep = async () => {
    if (
      !(await confirmDialog({
        title: `Keep ${props.code}?`,
        message: "The adoption offer ends and any pending requests on your cache are cancelled.",
        confirmLabel: "Keep my cache",
      }))
    )
      return;
    await run(() => keepCache(props.cacheId), "You keep your cache");
  };

  if (loadErr) return null; // the rest of the detail stands on its own
  if (!st) return null;
  const pending = st.request?.status === "pending";
  if (!st.offer && !pending) return null;
  const noticeRunning = !!st.offer && st.offer.noticeEndsAt > Math.floor(Date.now() / 1000);
  return (
    <section className="adopt-card" aria-label="Up for adoption">
      <div className="row between">
        <span className="ulabel">Up for adoption</span>
        {noticeRunning && <Badge kind="warn">owner notice until {fmt.date(st.offer!.noticeEndsAt)}</Badge>}
      </div>
      {st.offer && <p className="m-0">{st.offer.note}</p>}
      {st.isOwner ? (
        <>
          <p className="muted fine">The sysop has offered your cache to the community. Keep it and the offer ends.</p>
          <div className="row">
            <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void keep()}>
              {busy ? "Keeping…" : "Keep my cache"}
            </Button>
          </div>
        </>
      ) : pending ? (
        <>
          <p className="muted fine" role="status">
            Your request as <span className="mono">{st.request!.callsign}</span> is waiting for the sysop.
          </p>
          <Button
            variant="inline-danger"
            disabled={busy}
            onClick={() => void run(() => cancelAdoptionRequest(props.cacheId), "Request withdrawn")}
          >
            Withdraw my request
          </Button>
        </>
      ) : st.canRequest ? (
        <>
          <label className="row">
            <input type="checkbox" checked={inPlace} onChange={(e) => setInPlace(e.target.checked)} /> I have checked
            that the container is in place
          </label>
          <label className="adopt-note">
            <span className="muted fine">Note for the sysop (optional)</span>
            <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p className="muted fine">
            {inPlace
              ? "On approval the cache becomes yours and active again."
              : "On approval the cache becomes yours and stays archived until you edit it."}
          </p>
          <div className="row">
            <Button
              disabled={busy}
              aria-busy={busy}
              onClick={() =>
                void run(
                  () => requestAdoption(props.cacheId, inPlace, note.trim() || undefined),
                  "Request sent to the sysop",
                )
              }
            >
              {busy ? "Sending…" : "Request adoption"}
            </Button>
          </div>
        </>
      ) : (
        <p className="muted fine">
          {st.reason === "sign in to adopt a cache" ? (
            <Button variant="quiet" onClick={props.onSignIn}>
              Sign in to adopt this cache
            </Button>
          ) : (
            (st.reason ?? "").replace(/^./, (ch) => ch.toUpperCase())
          )}
          {st.reason?.startsWith("verify") && " — in Settings, under Account."}
        </p>
      )}
      {err && (
        <p className="error fine" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

/** Share funnel: copy the deep-link or print a QR for visitors to scan at the site. */
function ShareCache(props: { code: string; title: string; onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const url = cacheShareUrl(props.code);
  const qr = cacheQrUrl(props.code, 256);
  return (
    <div className="sharecache">
      <div className="row gap-2">
        <Button
          onClick={() => {
            void copyText(url).then((ok) =>
              props.onToast(ok ? "Share link copied" : "Copy failed — copy the link from the QR view"),
            );
          }}
        >
          <Icon name="share" size={15} /> Copy link
        </Button>
        <Button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          ▦ QR
        </Button>
      </div>
      {open && (
        <div className="qrbox">
          <img src={qr} width={180} height={180} alt={`QR linking to ${props.code}`} />
          <div className="col">
            <a href={qr} download={`aprscache-${props.code}.svg`}>
              download SVG
            </a>
            <p className="muted fine">
              Print it at your station, shack or the cache site so visitors can scan and find{" "}
              <span className="mono">{props.code}</span>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function LogRow(props: { log: CacheLogEntry; ago: string; dist: string | null; sync: string | null }) {
  const l = props.log;
  const tier: Tier = l.logType === "found" && l.verified ? ((l.tier ?? "C") as Tier) : "C";
  const method = [
    l.logType === "found" && TIER_NAME[tier],
    props.dist,
    l.corroboratedBy && `via ${l.corroboratedBy}${l.corroboratedLaterAt ? ", confirmed later" : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="logrow">
      {l.logType === "found" ? (
        <TierChip tier={tier} title={`${TIER_NAME[tier]} · Tier ${tier}`} />
      ) : (
        <Badge kind={l.logType}>{l.logType}</Badge>
      )}
      <div className="logrow-t">
        <div className="logrow-h">
          <span className="call">{l.loggerCall}</span>
          {l.signerKey && (
            <span className="signed" title="device-signed">
              <Icon name="shield-check" size={14} />
            </span>
          )}
          <span className="logrow-when">{props.ago}</span>
        </div>
        {method && <div className="logrow-method">{method}</div>}
        {props.sync && <div className="logrow-method">{props.sync}</div>}
        {l.comment && <div className="logrow-note">{l.comment}</div>}
      </div>
    </div>
  );
}
