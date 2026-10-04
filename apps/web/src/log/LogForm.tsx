// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { getInstance, registerKey, logFind, type LogResult, type AppGeo } from "../api.js";
import { signAuthorship } from "../crypto.js";
import { useFmt, type Formatters } from "../format.js";
import { haversine } from "../map/geo.js";
import { Button, TierBadge, TIER_NAME, useConfirm, Card, Icon } from "../ui/index.js";
import { TEXT_LIMITS, type LogType } from "@aprscaching/shared";
import { refusalMessage } from "../caches/formLimits.js";
import { EVIDENCE_MAX_AGE_MS, toAppGeo } from "../geo/location.js";
import { LocateStatus, useLocate } from "../geo/useLocate.js";
import { TermHelp } from "../platform/TermHelp.js";

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
  /** The cache's owner: may log maintenance (queued offline like any log, e.g. from the owner's pack). */
  isOwner?: boolean;
  /** An archived or disabled cache takes no find and no did-not-find; a note stays possible. */
  cacheStatus?: string;
  onLogged: () => void;
  onSignIn: () => void;
  /** Counts the requests to log a find from elsewhere on the sheet (the Find view): each new one runs it. */
  logRequest?: number;
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
  const loc = useLocate();

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
      // The device's own reading is the in-app evidence (Tier B). A find without one still logs, and
      // stays Tier C unless a receiving station heard it; a typed coordinate is never sent as evidence.
      let appGeo: AppGeo | undefined;
      if (logType === "found") {
        const got = await loc.locate(EVIDENCE_MAX_AGE_MS);
        if ("cancelled" in got) return;
        appGeo = "fix" in got ? toAppGeo(got.fix) : undefined;
      }
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
      const r = await logFind(
        props.cacheId,
        { loggerCall: props.callsign, logType, comment, appGeo, author },
        props.cacheCode,
      );
      setResult(r);
      setNote("");
      setNoteOpen(false);
      props.onLogged();
    } catch (e) {
      setErr(refusalMessage(e));
    } finally {
      setBusy(null);
    }
  }

  // a request from the Find view: bring the form into sight and log the find, once per request
  const formRef = useRef<HTMLDivElement>(null);
  const handled = useRef(props.logRequest ?? 0);
  useEffect(() => {
    const n = props.logRequest ?? 0;
    if (n === handled.current) return;
    handled.current = n;
    formRef.current?.scrollIntoView({ block: "nearest" });
    if (!busy) void doLog("found");
  });

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
      <Card ref={formRef} className="logresult" role="status">
        <div className="big">
          {result.queued ? "Saved" : verb} {found && result.verified && !result.duplicate ? "✓" : ""}
        </div>
        {result.queued ? (
          <div className="muted mt-1">
            <Icon name="offline" cp437="" className="lead-ic" />
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
              <p className="muted fine">
                <TermHelp term="tier">How finds are verified</TermHelp>
              </p>
              {!result.verified && !hadGeo && (
                <LocateStatus waiting={null} problem={loc.problem} onCancel={loc.cancel} />
              )}
            </>
          )
        )}
        {result.announced && <div className="muted mt-1">announced to APRS-IS</div>}
        {result.signerKey && (
          <div className="muted">
            signed with your device key <Icon name="edit" cp437="" className="lead-ic" />
          </div>
        )}
        {result.logType === "found" &&
          (noteOpen ? (
            <div className="mt-3">
              <textarea
                rows={2}
                placeholder="Add a note…"
                value={note}
                maxLength={TEXT_LIMITS.logComment}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="row end">
                <Button disabled={busy === "note" || !note.trim()} onClick={() => doLog("note", note.trim())}>
                  Post
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="quiet" className="mt-3" onClick={() => setNoteOpen(true)}>
              Add a note
            </Button>
          ))}
        {!found && (
          <Button variant="quiet" className="mt-3" onClick={() => setResult(null)}>
            Back
          </Button>
        )}
      </Card>
    );
  }

  // the game's rules (the gateway holds them too): no find on an archived or disabled cache, none on your own
  const inactive = props.cacheStatus && props.cacheStatus !== "active" ? props.cacheStatus : null;
  const noFind = inactive
    ? `This cache is ${inactive}: it takes no finds. You can still post a note.`
    : props.isOwner
      ? "You own this cache, so you don't log it as found. Post a note or a maintenance log."
      : null;
  return (
    <Card ref={formRef} className="logform">
      {noFind ? (
        <p className="muted" role="status">
          {noFind}
        </p>
      ) : (
        <>
          <Button
            variant="primary"
            className="log-primary"
            data-tour="log"
            disabled={!!busy}
            onClick={() => doLog("found")}
          >
            {busy === "found"
              ? loc.waiting
                ? `Locating… ${Math.floor(loc.waiting.elapsedMs / 1000)} s`
                : "Logging…"
              : "✓ Log a find"}
          </Button>
          <LocateStatus
            waiting={loc.waiting}
            problem={loc.problem}
            onCancel={loc.cancel}
            onSkip={loc.skipWait}
            skipLabel="Log without location"
          />
        </>
      )}
      <div className="row between mt-3">
        {!noFind && (
          <Button variant="quiet" disabled={!!busy} onClick={() => doLog("dnf")}>
            {busy === "dnf" ? "…" : "Couldn't find it"}
          </Button>
        )}
        <Button variant="quiet" onClick={() => setNoteOpen((v) => !v)}>
          Add a note
        </Button>
      </div>
      {noteOpen && (
        <div className="mt-2">
          <textarea
            rows={2}
            placeholder="Note…"
            value={note}
            maxLength={TEXT_LIMITS.logComment}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="row end">
            {props.isOwner && (
              <Button
                disabled={busy === "maintenance" || !note.trim()}
                onClick={() => doLog("maintenance", note.trim())}
                title="As the owner: what you checked or fixed"
              >
                Post as maintenance
              </Button>
            )}
            <Button disabled={busy === "note" || !note.trim()} onClick={() => doLog("note", note.trim())}>
              Post note
            </Button>
          </div>
        </div>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </Card>
  );
}
