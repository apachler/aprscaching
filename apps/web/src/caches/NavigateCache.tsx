// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type CSSProperties } from "react";
import { Icon } from "../ui/index.js";
import { useFmt } from "../format.js";
import { bearingDeg, bearing8, haversine, parseCoordinates } from "../map/geo.js";
import { NAV_MAX_AGE_MS } from "../geo/location.js";
import { LocateStatus, useLocate } from "../geo/useLocate.js";

/**
 * Navigate-to-cache — a one-tap field action. Hand-off links open the cache in the
 * device's own maps/navigation app (these need no permission and route from the phone's location), and
 * an on-demand bearing/compass readout uses a device fix, or a coordinate the cacher types, when they
 * want the heading + distance in the field. Real links/buttons; nothing here animates.
 */
export function NavigateCache(props: { lat: number; lon: number; title: string }) {
  const { lat, lon, title } = props;
  const fmt = useFmt();
  const [open, setOpen] = useState(false);
  const [fix, setFix] = useState<{ bearing: number; octant: string; distM: number; typed: boolean } | null>(null);
  const loc = useLocate();
  const [typed, setTyped] = useState("");
  const [typedErr, setTypedErr] = useState(false);

  const dest = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  // Universal + per-platform hand-offs. Google/Apple route from the device's current location.
  const links = [
    { label: "Maps app", href: `geo:${dest}?q=${dest}(${encodeURIComponent(title)})` },
    { label: "Google", href: `https://www.google.com/maps/dir/?api=1&destination=${dest}` },
    { label: "Apple", href: `https://maps.apple.com/?daddr=${dest}` },
    {
      label: "OpenStreetMap",
      href: `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=16/${lat.toFixed(4)}/${lon.toFixed(4)}`,
    },
  ];

  /** Bearing and distance from a point to the cache; `typed` marks a start the cacher typed in. */
  function from(aLat: number, aLon: number, typed: boolean) {
    setFix({
      bearing: bearingDeg(aLat, aLon, lat, lon),
      octant: bearing8(aLat, aLon, lat, lon),
      distM: haversine(aLat, aLon, lat, lon),
      typed,
    });
  }

  async function locate() {
    const got = await loc.locate(NAV_MAX_AGE_MS);
    if ("fix" in got) from(got.fix.lat, got.fix.lon, false);
  }

  function fromTyped() {
    const c = parseCoordinates(typed);
    setTypedErr(!c);
    if (c) from(c.lat, c.lon, true);
  }

  return (
    <div className="navcache">
      <button className="navcache-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="navigation" size={15} /> Navigate
      </button>
      {open && (
        <div className="navcache-body">
          <div className="navcache-links">
            {links.map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noreferrer noopener">
                {l.label} ↗
              </a>
            ))}
          </div>
          <div className="navcache-bearing">
            {fix && (
              <p className="mono" role="status">
                <span
                  className="navcache-arrow"
                  style={{ "--bearing": `${Math.round(fix.bearing)}deg` } as CSSProperties}
                  aria-hidden="true"
                >
                  ↑
                </span>{" "}
                {Math.round(fix.bearing)}° {fix.octant} · {fmt.distance(fix.distM)} away
                {fix.typed && <span className="muted"> from the typed point</span>}
              </p>
            )}
            <button className="link" onClick={() => void locate()} disabled={!!loc.waiting}>
              {loc.waiting ? "Getting a fix…" : fix ? "Update from here" : "Show bearing & distance from here"}
            </button>
            <LocateStatus waiting={loc.waiting} problem={loc.problem} onCancel={loc.cancel} />
            <form
              className="row coord-entry"
              onSubmit={(e) => {
                e.preventDefault();
                fromTyped();
              }}
            >
              <label>
                From coordinates
                <input
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="47.07355, 15.43785 or JN77rb"
                  aria-invalid={typedErr || undefined}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setTypedErr(false);
                  }}
                />
              </label>
              <button type="submit" disabled={!typed.trim()}>
                Show
              </button>
            </form>
            {typedErr && (
              <p className="error fine" role="alert">
                Not a coordinate. Type decimal degrees (lat, lon) or a Maidenhead locator.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
