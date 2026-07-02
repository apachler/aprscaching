// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Icon, useToast } from "../ui/index.js";
import { useFmt } from "../format.js";
import { bearingDeg, bearing8, haversine } from "../map/geo.js";

/**
 * Navigate-to-cache (docs/design/26 Stage 0.3) — a one-tap field action. Hand-off links open the cache in the
 * device's own maps/navigation app (these need no permission and route from the phone's location), and
 * an on-demand bearing/compass readout uses a one-shot geolocation fix when the cacher wants the
 * heading + distance in the field. Real links/buttons; nothing here animates.
 */
export function NavigateCache(props: { lat: number; lon: number; title: string }) {
  const { lat, lon, title } = props;
  const fmt = useFmt();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [fix, setFix] = useState<{ bearing: number; octant: string; distM: number } | null>(null);
  const [locating, setLocating] = useState(false);

  const dest = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  // Universal + per-platform hand-offs. Google/Apple route from the device's current location.
  const links = [
    { label: "Maps app", href: `geo:${dest}?q=${dest}(${encodeURIComponent(title)})` },
    { label: "Google", href: `https://www.google.com/maps/dir/?api=1&destination=${dest}` },
    { label: "Apple", href: `https://maps.apple.com/?daddr=${dest}` },
    { label: "OpenStreetMap", href: `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=16/${lat.toFixed(4)}/${lon.toFixed(4)}` },
  ];

  function locate() {
    if (!navigator.geolocation) { toast("Geolocation unavailable on this device"); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: aLat, longitude: aLon } = pos.coords;
        setFix({
          bearing: bearingDeg(aLat, aLon, lat, lon),
          octant: bearing8(aLat, aLon, lat, lon),
          distM: haversine(aLat, aLon, lat, lon),
        });
        setLocating(false);
      },
      (e) => { setLocating(false); toast(e.code === e.PERMISSION_DENIED ? "Location permission denied" : "Couldn't get a fix"); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
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
              <a key={l.label} href={l.href} target="_blank" rel="noreferrer noopener">{l.label} ↗</a>
            ))}
          </div>
          <div className="navcache-bearing">
            {fix ? (
              <p className="mono" role="status">
                <span className="navcache-arrow" style={{ transform: `rotate(${Math.round(fix.bearing)}deg)` }} aria-hidden="true">↑</span>
                {" "}{Math.round(fix.bearing)}° {fix.octant} · {fmt.distance(fix.distM)} away
              </p>
            ) : (
              <button className="link" onClick={locate} disabled={locating}>
                {locating ? "Getting a fix…" : "Show bearing & distance from here"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
