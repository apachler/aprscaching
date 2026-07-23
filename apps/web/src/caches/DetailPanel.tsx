// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type CSSProperties } from "react";
import {
  toggleFavorite,
  rateCache,
  getCacheLogs,
  cacheShareUrl,
  cacheQrUrl,
  type CacheDetail,
  type CacheRating,
  type Spot,
} from "../api.js";
import type { CacheLogEntry } from "@aprscaching/shared";
import { typeMeta, typeGlyph } from "../cacheTypes.js";
import { useFmt, useTheme } from "../format.js";
import { maidenhead } from "../map/geo.js";
import {
  Panel,
  Badge,
  Icon,
  Ico,
  TierChip,
  MinTier,
  DtBars,
  Stat,
  LoadMore,
  useToast,
  copyText,
  type Tier,
} from "../ui/index.js";
import { StagesSection } from "../log/StagesSection.js";
import { LogForm } from "../log/LogForm.js";
import { NavigateCache } from "./NavigateCache.js";
import { CacheMedia } from "./CacheMedia.js";

const TIER_DESC: Record<Tier, string> = {
  A: "RF-corroborated — heard on RF via an independent IGate.",
  B: "App-corroborated — in-app device geolocation at the cache.",
  C: "IS-only — a bare APRS-IS beacon, logged but unverified.",
};

/** Cache detail + logbook — operator layout; single primary action (Log a find). */
export function DetailPanel(props: {
  detail: CacheDetail;
  callsign: string;
  activating?: Spot | null;
  onClose: () => void;
  onLogged: () => void;
  onSignIn: () => void;
}) {
  const c = props.detail;
  const meta = typeMeta(c.type);
  const fmt = useFmt();
  const phosphor = useTheme() === "phosphor";
  const toast = useToast();
  const [fav, setFav] = useState({ on: c.favorited, count: c.favorites });
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
    if (props.callsign.length < 3) return;
    const want = !fav.on;
    setFav((f) => ({ on: want, count: f.count + (want ? 1 : -1) })); // optimistic
    try {
      const r = await toggleFavorite(c.id, props.callsign, want);
      setFav(r);
    } catch {
      setFav({ on: c.favorited, count: c.favorites });
    }
  }
  const minTier: Tier = c.minTrust ?? "B"; // site default is B (CLAUDE.md)
  const grid = c.lat != null && c.lon != null ? maidenhead(c.lat, c.lon, 10) : null;
  function copyCoords() {
    if (c.lat == null || c.lon == null) return;
    void copyText(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`).then((ok) =>
      toast(ok ? "Coordinates copied" : "Copy failed — long-press the coordinates to copy"),
    );
  }
  return (
    <Panel
      onClose={props.onClose}
      title={c.title}
      actions={
        <button className={`heart${fav.on ? " on" : ""}`} title="Favorite" onClick={toggleFav}>
          {fav.on ? "♥" : "♡"} {fav.count}
        </button>
      }
    >
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
        <span className="typechip" style={{ ["--tc"]: meta.color } as CSSProperties}>
          {typeGlyph(meta, phosphor)} {meta.label}
        </span>
        <span className="srcchip">
          {c.source === "native" ? "APRScaching" : `imported · ${c.sourceName ?? c.source}`}
        </span>
        <span className="dataval">{c.code}</span>
      </div>
      <p className="muted mt-1">
        by <span className="mono">{c.ownerCall}</span>
      </p>

      {(c.driveIn || c.country || c.tags.length > 0) && (
        <div className="badges cache-tags">
          {c.driveIn && (
            <span className="chip">
              <Ico e="🚗 " />
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

      <MinTier tier={minTier} desc={TIER_DESC[minTier]} />

      <RatingWidget cacheId={c.id} callsign={props.callsign} rating={c.rating} onToast={toast} />

      {grid && (
        <div className="coordblock">
          <div className="coordblock-h">
            <span className="ulabel">Coordinates</span>
            <button className="iconbtn" aria-label="Copy coordinates" onClick={copyCoords}>
              <Icon name="copy" size={16} />
            </button>
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
        <details>
          <summary>Hint</summary>
          <p>{c.hint}</p>
        </details>
      )}

      <CacheMedia cacheId={c.id} isOwner={props.callsign.toUpperCase() === c.ownerCall.toUpperCase()} onToast={toast} />

      {c.rendezvous.length > 0 && (
        <div className="rendezvous">
          <span className="ulabel">Rendezvous</span>
          <ul className="rdv-list">
            {c.rendezvous.map((r, i) => (
              <li key={`${r.withCacheId}-${r.ts}-${i}`}>
                <Ico e="🤝 " />
                met <span className="mono">{r.withCall}</span> <span className="muted">· {fmt.ago(r.ts)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.stageCount > 0 && <StagesSection cacheId={c.id} callsign={props.callsign} />}

      <LogForm
        cacheId={c.id}
        cacheCode={c.code}
        callsign={props.callsign}
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
                  style={{ height: `${Math.max(10, (m.n / max) * 100)}%` }}
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
        <LogRow key={l.id} log={l} ago={fmt.ago(l.ts)} dist={l.distanceM != null ? fmt.distance(l.distanceM) : null} />
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
            <button
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
            </button>
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

/** Share funnel: copy the deep-link or print a QR for visitors to scan at the site. */
function ShareCache(props: { code: string; title: string; onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const url = cacheShareUrl(props.code);
  const qr = cacheQrUrl(props.code, 256);
  return (
    <div className="sharecache">
      <div className="row gap-2">
        <button
          onClick={() => {
            void copyText(url).then((ok) =>
              props.onToast(ok ? "Share link copied" : "Copy failed — copy the link from the QR view"),
            );
          }}
        >
          <Icon name="share" size={15} /> Copy link
        </button>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          ▦ QR
        </button>
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

function LogRow(props: { log: CacheLogEntry; ago: string; dist: string | null }) {
  const l = props.log;
  const method = [
    l.verifyMethod && `method: ${l.verifyMethod}`,
    props.dist,
    l.corroboratedBy && `via ${l.corroboratedBy}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="logrow">
      {l.logType === "found" ? (
        <TierChip tier={(l.tier ?? "C") as Tier} title={l.verified ? `Verified · tier ${l.tier}` : "unverified"} />
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
        {l.comment && <div className="logrow-note">{l.comment}</div>}
      </div>
    </div>
  );
}
