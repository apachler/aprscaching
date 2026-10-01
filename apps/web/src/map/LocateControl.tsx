// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import { Icon, Button } from "../ui/index.js";
import { locationSupport, watchFixes, watchPermission, type DeviceFix, type LocationProblem } from "../geo/location.js";
import { LocateStatus } from "../geo/useLocate.js";

/**
 * off: no watch · waiting: watching for the first fix · follow: the camera follows each fix ·
 * background: the dot keeps moving but the camera stays where the user panned it.
 */
type Mode = "off" | "waiting" | "follow" | "background";

const LABEL: Record<Mode, string> = {
  off: "Show my location",
  waiting: "Waiting for GPS — tap to stop",
  follow: "Following my location — tap to stop",
  background: "Centre on my location",
};

const BLOCKED_LABEL = "Location is blocked for this site — tap for how to allow it";
const INSECURE_LABEL = "Location needs a secure page (https or localhost)";

/**
 * The map's locate button, in the map's top-left control stack under the zoom buttons. Every tap
 * asks the browser directly, so a site the user has not answered yet gets the permission prompt; a
 * denial is explained in one line and the button stays usable for a retry once it is allowed. It
 * waits for a GPS-only first fix as long as the user lets it (showing how long), then tracks: the
 * camera follows each fix until the user pans, after which a tap re-centres.
 */
export function LocateControl(props: { map: maplibregl.Map | null; onFix: (lat: number, lon: number) => void }) {
  const { map } = props;
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [lineBox, setLineBox] = useState<HTMLElement | null>(null);
  const [mode, setMode] = useState<Mode>("off");
  const [problem, setProblem] = useState<LocationProblem | null>(null);
  const [waiting, setWaiting] = useState<{ elapsedMs: number; hint: LocationProblem | null } | null>(null);
  const modeRef = useRef<Mode>("off");
  const stopRef = useRef<(() => void) | null>(null);
  const dot = useRef<maplibregl.Marker | null>(null);
  const lastRef = useRef<DeviceFix | null>(null);
  const onFix = useRef(props.onFix);
  onFix.current = props.onFix;
  // a site blocked in the browser's settings fails every request without a prompt: say so up front
  // (an insecure page reports "denied" too, but its reason is the page, named by its own label)
  const insecure = locationSupport() === "insecure";
  const [denied, setDenied] = useState(false);
  useEffect(() => watchPermission((state) => setDenied(state === "denied")), []);
  const blocked = denied || insecure;
  const blockedLabel = insecure ? INSECURE_LABEL : BLOCKED_LABEL;

  const go = useCallback((m: Mode) => {
    modeRef.current = m;
    setMode(m);
  }, []);

  // Two MapLibre controls whose DOM React renders into: the button joins the map's own stack, and the
  // status line stacks right under it, so neither overlaps the other map overlays.
  useEffect(() => {
    if (!map) return;
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const ctl: maplibregl.IControl = { onAdd: () => el, onRemove: () => el.remove() };
    map.addControl(ctl, "top-left");
    const line = document.createElement("div");
    line.className = "maplibregl-ctrl map-locate-slot";
    const lineCtl: maplibregl.IControl = { onAdd: () => line, onRemove: () => line.remove() };
    map.addControl(lineCtl, "top-left");
    setBox(el);
    setLineBox(line);
    const onMoveStart = (e: maplibregl.MapLibreEvent & { locateSource?: boolean }) => {
      if (!e.locateSource && modeRef.current === "follow" && !map.isZooming()) go("background");
    };
    map.on("movestart", onMoveStart);
    return () => {
      map.off("movestart", onMoveStart);
      try {
        map.removeControl(ctl);
        map.removeControl(lineCtl);
      } catch {
        /* the map is already gone */
      }
      setBox(null);
      setLineBox(null);
    };
  }, [map, go]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    dot.current?.remove();
    dot.current = null;
    setWaiting(null);
    go("off");
  }, [go]);
  useEffect(() => stop, [stop]);

  const centre = useCallback(
    (fix: DeviceFix) => {
      if (!map) return;
      map.easeTo({ center: [fix.lon, fix.lat], zoom: Math.max(map.getZoom(), 15) }, { locateSource: true });
    },
    [map],
  );

  const start = useCallback(() => {
    if (!map) return;
    setProblem(null);
    go("waiting");
    const started = Date.now();
    setWaiting({ elapsedMs: 0, hint: null });
    let hint: LocationProblem | null = null;
    const tick = setInterval(() => setWaiting({ elapsedMs: Date.now() - started, hint }), 1000);
    const stopWatch = watchFixes({
      onFix: (fix) => {
        clearInterval(tick);
        setWaiting(null);
        lastRef.current = fix;
        if (!dot.current) {
          const el = document.createElement("div");
          el.className = "user-dot";
          dot.current = new maplibregl.Marker({ element: el }).setLngLat([fix.lon, fix.lat]).addTo(map);
        } else dot.current.setLngLat([fix.lon, fix.lat]);
        dot.current.getElement().title = `My location, ±${Math.round(fix.accuracyM)} m`;
        if (modeRef.current === "waiting") go("follow");
        if (modeRef.current === "follow") centre(fix);
        onFix.current(fix.lat, fix.lon);
      },
      onProblem: (kind) => {
        if (kind === "unavailable") {
          hint = kind;
          return;
        }
        clearInterval(tick);
        stop();
        setProblem(kind);
      },
    });
    stopRef.current = () => {
      clearInterval(tick);
      stopWatch();
    };
  }, [map, go, centre, stop]);

  function onClick() {
    // a blocked site is asked anyway: the browser may prompt after all, and a denial explains itself
    if (mode === "off") start();
    else if (mode === "background") {
      go("follow");
      if (lastRef.current) centre(lastRef.current);
    } else stop();
  }

  return (
    <>
      {box &&
        createPortal(
          <Button
            type="button"
            className="locate-btn"
            data-mode={mode}
            data-blocked={blocked && mode === "off" ? "" : undefined}
            aria-pressed={mode !== "off"}
            aria-label={blocked && mode === "off" ? blockedLabel : LABEL[mode]}
            title={blocked && mode === "off" ? blockedLabel : LABEL[mode]}
            onClick={onClick}
          >
            <Icon name="locate" size={18} />
          </Button>,
          box,
        )}
      {lineBox &&
        (waiting || problem) &&
        createPortal(
          <div className="map-locate-status">
            <LocateStatus waiting={waiting} problem={problem} onCancel={stop} />
            {problem && (
              <Button type="button" variant="icon" aria-label="Dismiss" onClick={() => setProblem(null)}>
                <Icon name="close" size={14} />
              </Button>
            )}
          </div>,
          lineBox,
        )}
    </>
  );
}
