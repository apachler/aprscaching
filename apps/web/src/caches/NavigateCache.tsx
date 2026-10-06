// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Icon, Button } from "../ui/index.js";

/**
 * Getting to a cache. **Find** opens the in-app compass for the last stretch on foot (`FindView`); **Navigate**
 * hands the coordinates to a maps app for the drive there. The hand-off links need no permission: Google and Apple
 * route from the phone's own location, and the phone's maps app and OpenStreetMap show the spot.
 */
export function NavigateCache(props: { lat: number; lon: number; title: string; onFind?: () => void }) {
  const { lat, lon, title } = props;
  const [open, setOpen] = useState(false);

  const dest = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  const links = [
    { label: "Maps app", href: `geo:${dest}?q=${dest}(${encodeURIComponent(title)})` },
    { label: "Google", href: `https://www.google.com/maps/dir/?api=1&destination=${dest}` },
    { label: "Apple", href: `https://maps.apple.com/?daddr=${dest}` },
    {
      label: "OpenStreetMap",
      href: `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=16/${lat.toFixed(4)}/${lon.toFixed(4)}`,
    },
  ];

  return (
    <div className="navcache">
      <div className="navcache-row">
        {props.onFind && (
          <Button className="navcache-btn" onClick={props.onFind}>
            <Icon name="locate" size={15} /> Find
          </Button>
        )}
        <Button className="navcache-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="navigation" size={15} /> Navigate
        </Button>
      </div>
      {open && (
        <div className="navcache-body">
          <div className="navcache-links">
            {links.map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noreferrer noopener">
                {l.label} ↗
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
