// SPDX-License-Identifier: AGPL-3.0-or-later
import { Panel, Icon, Ico } from "../ui/index.js";
import type { WorkbenchApp, WorkbenchAppId } from "./apps.js";

/**
 * Workbench — a pure app launcher. Every workbench app (terminal, BBS, decoder, NET/ROM node, tools,
 * rig, remote) launches into its own surface (WorkbenchAppSurface) and can be pinned to the nav rail.
 * APRS/APRScaching functionality lives OUTSIDE the workbench: platform config in Settings (Connections
 * & sources / Network / Notifications), live stations on the map (layer toggle + station detail sheet).
 */
export function WorkbenchPanel(props: {
  onClose: () => void;
  apps: WorkbenchApp[];
  pinned: WorkbenchAppId[];
  onLaunchApp: (id: WorkbenchAppId) => void;
  onTogglePin: (id: WorkbenchAppId) => void;
}) {
  return (
    <Panel
      title={
        <>
          <Ico e="📡 " />
          Workbench
        </>
      }
      onClose={props.onClose}
    >
      <p className="muted">
        Your <strong>field station</strong>: these apps drive a radio straight from this browser (Web Serial / Bluetooth
        / audio) or run on the platform — so you can operate off-grid with just a laptop and a rig, no server box.
        Launch one, or pin it to the left rail.
      </p>

      <div className="wb-apps" role="list">
        {props.apps.map((app) => {
          const pinned = props.pinned.includes(app.id);
          return (
            <div key={app.id} className="wb-app" role="listitem">
              <button className="wb-app-launch" onClick={() => props.onLaunchApp(app.id)}>
                <Icon name={app.icon} size={22} />
                <span className="wb-app-t">
                  <span className="wb-app-label">
                    {app.label}
                    {app.sysop && (
                      <span className="wb-app-op" title="Operator only — administers this instance's server RF box">
                        {" "}
                        · operator
                      </span>
                    )}
                  </span>
                  <span className="wb-app-blurb muted">{app.blurb}</span>
                </span>
              </button>
              <button
                className={`icon wb-pin${pinned ? " on" : ""}`}
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
