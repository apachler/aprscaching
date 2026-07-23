// SPDX-License-Identifier: AGPL-3.0-or-later
import { Panel, Icon, Ico } from "../ui/index.js";
import type { ShackApp, ShackAppId } from "./apps.js";

/**
 * Shack — a pure app launcher. Every shack app (terminal, BBS, decoder, NET/ROM node, tools,
 * rig, remote) launches into its own surface (ShackAppSurface) and can be pinned to the nav rail.
 * APRS/APRScaching functionality lives OUTSIDE the shack: platform config in Settings (Connections
 * & sources / Network / Notifications), live stations on the map (layer toggle + station detail sheet).
 */
export function ShackPanel(props: {
  onClose: () => void;
  apps: ShackApp[];
  pinned: ShackAppId[];
  onLaunchApp: (id: ShackAppId) => void;
  onTogglePin: (id: ShackAppId) => void;
}) {
  return (
    <Panel
      title={
        <>
          <Ico e="📡 " />
          Shack
        </>
      }
      onClose={props.onClose}
    >
      <p className="muted">
        Your <strong>field station</strong>: these apps drive a radio straight from this browser (Web Serial / Bluetooth
        / audio) or run on the platform — so you can operate off-grid with just a laptop and a rig, no server box.
        Launch one, or pin it to the left rail.
      </p>

      <div className="shack-apps" role="list">
        {props.apps.map((app) => {
          const pinned = props.pinned.includes(app.id);
          return (
            <div key={app.id} className="shack-app" role="listitem">
              <button className="shack-app-launch" onClick={() => props.onLaunchApp(app.id)}>
                <Icon name={app.icon} size={22} />
                <span className="shack-app-t">
                  <span className="shack-app-label">
                    {app.label}
                    {app.sysop && (
                      <span className="shack-app-op" title="Operator only — administers this instance's server RF box">
                        {" "}
                        · operator
                      </span>
                    )}
                  </span>
                  <span className="shack-app-blurb muted">{app.blurb}</span>
                </span>
              </button>
              <button
                className={`icon shack-pin${pinned ? " on" : ""}`}
                aria-pressed={pinned}
                title={pinned ? `Unpin ${app.label} from the rail` : `Pin ${app.label} to the rail`}
                onClick={() => props.onTogglePin(app.id)}
              >
                <Icon name={pinned ? "pin-off" : "pin"} size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
