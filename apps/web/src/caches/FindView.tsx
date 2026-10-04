// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Button, Icon } from "../ui/index.js";
import { useModalDialog } from "../ui/useModalDialog.js";
import { useFmt } from "../format.js";
import { bearingDeg, bearing8, haversine } from "../map/geo.js";
import { NAV_MAX_AGE_MS, PROBLEM_TEXT, isFresh, lastFix, watchFixes, type DeviceFix } from "../geo/location.js";
import type { LocationProblem } from "../geo/location.js";
import {
  PIN_ACCURACY_M,
  atThePin,
  compassNeedsPermission,
  courseTracker,
  needsCalibration,
  requestCompass,
  smoothAngle,
  turn,
  watchHeading,
} from "../geo/heading.js";

type Compass = "ask" | "waiting" | "on" | "none";

/** Keep the screen on while the view is open; the lock is let go when the page hides, and taken again on return. */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let open = true;
    const take = async () => {
      try {
        const got = (await navigator.wakeLock?.request("screen")) ?? null;
        // the view may have closed while the request was pending: a lock taken then is let go at once
        if (!open) void got?.release().catch(() => {});
        else lock = got;
      } catch {
        // refused (battery saver, an unfocused page): the screen times out as usual
      }
    };
    const onVisible = () => {
      if (open && document.visibilityState === "visible") void take();
    };
    void take();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      open = false;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, []);
}

/**
 * Find — the last few hundred metres to a cache, without leaving the app. A needle points at the cache: it turns
 * with the phone's compass, follows the direction of travel where there is no compass, and points from north
 * when neither is known yet. The distance and the reading's accuracy update with every GPS reading; within that
 * accuracy of the pin the needle hands over to the eye. The screen stays on while the view is open, and it needs
 * no connection. Logging the find is the view's one primary action.
 */
export function FindView(props: {
  lat: number;
  lon: number;
  title: string;
  code: string;
  /** Absent where the cache takes no find from this player (archived, disabled, or their own). */
  onLog?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // what had focus when the view opened, read before any effect moves it
  const opener = useRef(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
  useModalDialog(ref, props.onClose);
  useWakeLock();
  // the app behind the view is out of reach (taps, Tab and screen readers) while it is open
  useEffect(() => {
    const app = document.getElementById("root");
    if (!app) return;
    const back = opener.current;
    app.inert = true;
    return () => {
      app.inert = false;
      // focus went back while the app was still inert, which leaves it on the page body: give it to the opener now
      if (!document.activeElement || document.activeElement === document.body) back?.focus?.();
    };
  }, []);
  const fmt = useFmt();

  const [fix, setFix] = useState<DeviceFix | null>(() => {
    const f = lastFix();
    return f && isFresh(f, NAV_MAX_AGE_MS) ? f : null;
  });
  const [problem, setProblem] = useState<LocationProblem | null>(null);
  const [course, setCourse] = useState<number | null>(null);
  const track = useRef(courseTracker());
  useEffect(
    () =>
      watchFixes({
        onFix: (f) => {
          setProblem(null);
          setFix(f);
          setCourse(track.current(f.lat, f.lon, f.accuracyM));
        },
        onProblem: setProblem,
      }),
    [],
  );

  const [compass, setCompass] = useState<Compass>(() => (compassNeedsPermission() ? "ask" : "waiting"));
  const [heading, setHeading] = useState<number | null>(null);
  const [calibrate, setCalibrate] = useState(false);
  const asking = compass === "ask";
  useEffect(() => {
    if (asking) return;
    let h: number | null = null;
    return watchHeading({
      onHeading: (r) => {
        const next = smoothAngle(h, r.deg);
        setCompass("on");
        setCalibrate(needsCalibration(r));
        // a degree is below what the eye reads off the needle; skipping smaller steps spares re-renders
        if (h == null || Math.abs(turn(h, next)) >= 1) setHeading(next);
        h = next;
      },
      onNone: () => setCompass((c) => (c === "on" ? c : "none")),
    });
  }, [asking]);

  async function enableCompass() {
    setCompass((await requestCompass()) ? "waiting" : "none");
  }

  const dist = fix ? haversine(fix.lat, fix.lon, props.lat, props.lon) : null;
  const bearing = fix ? bearingDeg(fix.lat, fix.lon, props.lat, props.lon) : null;
  const octant = fix ? bearing8(fix.lat, fix.lon, props.lat, props.lon) : null;
  const here = fix && dist != null && atThePin(dist, fix.accuracyM);
  // a coarse reading (cell or Wi-Fi) puts the pin "within accuracy" from far away: say so instead
  const coarse = !!fix && fix.accuracyM > PIN_ACCURACY_M;
  // what the top of the screen faces: the compass, else the way the walker is going, else north
  const facing = compass === "on" ? heading : course;
  const needle = bearing == null ? null : facing == null ? bearing : turn(facing, bearing);
  const mode = compass === "on" ? "compass" : course != null ? "course" : "north";

  // over the whole page, not inside the sheet that opened it (a transformed sheet would hold a fixed child)
  return createPortal(
    <div className="find-backdrop">
      <div ref={ref} className="find" role="dialog" aria-modal="true" aria-labelledby="find-title">
        <div className="find-head">
          <h2 id="find-title" className="find-title">
            {props.title} <span className="mono muted">{props.code}</span>
          </h2>
          <Button variant="icon" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </Button>
        </div>

        <div
          className={`find-dial${here ? " at-pin" : ""}${needle == null ? " no-fix" : ""}`}
          data-mode={mode}
          style={
            {
              "--needle": `${Math.round(needle ?? 0)}deg`,
              "--north": `${Math.round(facing == null ? 0 : -facing)}deg`,
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <span className="find-north">N</span>
          <svg className="find-needle" viewBox="0 0 100 100">
            <path d="M50 6 L68 62 L50 52 L32 62 Z" />
          </svg>
        </div>

        <div className="find-readout">
          {dist != null && fix ? (
            <>
              <p className="find-dist mono">{fmt.distance(dist)}</p>
              <p className="mono muted">
                {Math.round(bearing!)}° {octant} · ±{fmt.distance(fix.accuracyM)}
              </p>
            </>
          ) : (
            <p className="muted" role="status">
              {problem ? PROBLEM_TEXT[problem] : "Waiting for GPS…"}
            </p>
          )}
          {here && (
            <p className="find-here" role="status">
              You&apos;re within GPS accuracy of the pin — search here.
            </p>
          )}
          {coarse && (
            <p className="muted fine" role="status">
              The reading is too coarse (±{fmt.distance(fix!.accuracyM)}) to lead you to the pin: wait for GPS,
              outdoors.
            </p>
          )}
        </div>

        <div className="find-status">
          {compass === "ask" && (
            <Button onClick={() => void enableCompass()}>
              <Icon name="navigation" size={15} /> Use the compass
            </Button>
          )}
          {mode === "course" && <p className="muted fine">No compass: the arrow follows the way you walk.</p>}
          {mode === "north" && compass !== "ask" && fix && (
            <p className="muted fine">No compass: the arrow points from north. Walk a few steps and it follows you.</p>
          )}
          {compass === "on" && calibrate && (
            <p className="inline-note" role="alert">
              The compass is unsure: move the phone in a figure-eight, away from cars and metal.
            </p>
          )}
        </div>

        <div className="find-actions">
          {props.onLog ? (
            <Button variant="primary" onClick={props.onLog}>
              ✓ Log a find
            </Button>
          ) : (
            <Button onClick={props.onClose}>Back to the cache</Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
