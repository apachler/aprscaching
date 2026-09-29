// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { getInstance, registerKey, logFind, errorText, type LogResult, type AppGeo } from "../api.js";
import { signAuthorship } from "../crypto.js";
import { useFmt, type Formatters } from "../format.js";
import { haversine } from "../map/geo.js";
import { TierBadge, TIER_NAME, Ico, useConfirm } from "../ui/index.js";
import type { LogType } from "@aprscaching/shared";

/**
 * How near a device reading must be to verify a find: the gateway's match radius plus the reading's own
 * accuracy, capped (the verify policy's `radiusM` and accuracy clamp). Farther than this, a find can only
 * be Logged.
 */
const MATCH_RADIUS_M = 150;
const MAX_ACCURACY_M = 200;
const reachM = (g: AppGeo) => MATCH_RADIUS_M + Math.max(0, Math.min(g.accuracyM, MAX_ACCURACY_M));

/** What placed (or failed to place) the finder at the cache, in words, for the result card. */
function findWhy(r: LogResult, fmt: Formatters, geoAwayM: number | null, hadGeo: boolean): string {
  const d = r.distanceM != null ? fmt.distance(r.distanceM) : null;
  if (r.verified) {
    if (r.tier === "A")
      return `A receiving station heard your transmission on the air at the cache${
        r.corroboratedBy ? `, confirmed by ${r.corroboratedBy}` : ""
      }.`;
    if (r.tier === "B")
      return `Your device was ${d ?? "at the cache"}${d ? " from the cache" : ""} when you logged it.`;
    return "This cache counts every logged find.";
  }
  const needs = /requires tier ([ABC])/.exec(r.reason ?? "")?.[1] as "A" | "B" | "C" | undefined;
  if (needs && r.tier)
    return `This cache needs a ${TIER_NAME[needs]} find. Yours was ${TIER_NAME[r.tier]}, so it is on record but does not count as verified.`;
  if (r.method === "aprs_is")
    return "Only an internet (APRS-IS) position placed you here. Anyone can send one, so it cannot verify a find.";
  if (geoAwayM != null) return `Your device was ${fmt.distance(geoAwayM)} from the cache — too far to verify the find.`;
  if (!hadGeo)
    return "Your location was not available and no receiving station heard you here. Allow location access and log at the cache to verify a find.";
  return "Nothing placed you at the cache when you logged it.";
}

/**
 * One-tap log (the core action). A found is one per cache and callsign and is scored once, when it is
 * logged: a find from far away is confirmed first, and the result says in words which tier it reached
 * and why.
 */
export function LogForm(props: {
  cacheId: number;
  cacheCode: string;
  cacheLat: number | null;
  cacheLon: number | null;
  callsign: string;
  onLogged: () => void;
  onSignIn: () => void;
}) {
  const fmt = useFmt();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<LogType | null>(null);
  const [result, setResult] = useState<LogResult | null>(null);
  // the device reading sent with the find: how far from the cache it was, and whether there was one
  const [geoAway, setGeoAway] = useState<number | null>(null);
  const [hadGeo, setHadGeo] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  // request the device fix (Tier-B path); resolve undefined if denied/unavailable so the tap still succeeds
  function getGeo(): Promise<AppGeo | undefined> {
    if (!navigator.geolocation) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve({
            lat: p.coords.latitude,
            lon: p.coords.longitude,
            accuracyM: p.coords.accuracy ?? 9999,
            ts: Math.floor(p.timestamp / 1000),
          }),
        () => resolve(undefined),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });
  }

  async function doLog(logType: LogType, comment?: string) {
    if (props.callsign.length < 3) {
      // signed out: route straight into sign-in — the find is one sign-in away, not a dead end
      setErr("Sign in to log your find.");
      props.onSignIn();
      return;
    }
    setBusy(logType);
    setErr(null);
    try {
      const appGeo = logType === "found" ? await getGeo() : undefined;
      const away =
        appGeo && props.cacheLat != null && props.cacheLon != null
          ? haversine(appGeo.lat, appGeo.lon, props.cacheLat, props.cacheLon)
          : null;
      const far = appGeo != null && away != null && away > reachM(appGeo);
      if (
        far &&
        !(await confirm({
          title: "Log this find?",
          message: `You're ${fmt.distance(away)} from the cache — log anyway? From here it is recorded as Logged, not verified, and each cache takes one find from you.`,
          confirmLabel: "Log anyway",
          cancelLabel: "Not yet",
        }))
      )
        return;
      setGeoAway(far ? away : null);
      setHadGeo(appGeo != null);
      let author;
      try {
        const instance = await getInstance();
        if (instance) {
          const at = Math.floor(Date.now() / 1000);
          author = await signAuthorship({ cache: props.cacheCode, instance, logger: props.callsign, logType, at });
          if (author) await registerKey({ callsign: props.callsign, publicKey: author.authorKey }).catch(() => {});
        }
      } catch {
        /* unsupported browser -> log unsigned */
      }
      const r = await logFind(props.cacheId, { loggerCall: props.callsign, logType, comment, appGeo, author });
      setResult(r);
      setNote("");
      setNoteOpen(false);
      props.onLogged();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (result) {
    const found = result.logType === "found";
    const verb = found
      ? result.duplicate
        ? "You already logged this"
        : "Logged"
      : result.logType === "dnf"
        ? "Marked DNF"
        : "Note posted";
    return (
      <div className="logresult" role="status">
        <div className="big">
          {result.queued ? "Saved" : verb} {found && result.verified && !result.duplicate ? "✓" : ""}
        </div>
        {result.queued ? (
          <div className="muted mt-1">
            <Ico e="📴 " />
            offline — will sync when you're back online
          </div>
        ) : (
          found && (
            <>
              <div className="tier">
                <TierBadge tier={result.tier} verified={result.verified} letter />
              </div>
              <p className="logresult-why">
                {result.duplicate
                  ? "A cache takes one find from each callsign, and your first log stands as it was scored."
                  : findWhy(result, fmt, geoAway, hadGeo)}
              </p>
            </>
          )
        )}
        {result.announced && <div className="muted mt-1">announced to APRS-IS</div>}
        {result.signerKey && (
          <div className="muted">
            signed with your device key <Ico e="✍" />
          </div>
        )}
        {result.logType === "found" &&
          (noteOpen ? (
            <div className="mt-3">
              <textarea rows={2} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row end">
                <button disabled={busy === "note" || !note.trim()} onClick={() => doLog("note", note.trim())}>
                  Post
                </button>
              </div>
            </div>
          ) : (
            <button className="link mt-3" onClick={() => setNoteOpen(true)}>
              Add a note
            </button>
          ))}
        {!found && (
          <button className="link mt-3" onClick={() => setResult(null)}>
            Back
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="logform">
      <button className="primary log-primary" data-tour="log" disabled={!!busy} onClick={() => doLog("found")}>
        {busy === "found" ? "Logging…" : "✓ Log a find"}
      </button>
      <div className="row between mt-3">
        <button className="link" disabled={!!busy} onClick={() => doLog("dnf")}>
          {busy === "dnf" ? "…" : "Couldn't find it"}
        </button>
        <button className="link" onClick={() => setNoteOpen((v) => !v)}>
          Add a note
        </button>
      </div>
      {noteOpen && (
        <div className="mt-2">
          <textarea rows={2} placeholder="Note…" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row end">
            <button disabled={busy === "note" || !note.trim()} onClick={() => doLog("note", note.trim())}>
              Post note
            </button>
          </div>
        </div>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
