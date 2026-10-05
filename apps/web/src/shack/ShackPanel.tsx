// SPDX-License-Identifier: AGPL-3.0-or-later
import { Panel, Icon, Button, InfoTip, Hint } from "../ui/index.js";
import type { PinId, ShackApp, ShackAppId } from "./apps.js";
import { TERMS } from "../terms.js";

/**
 * Shack — a pure app launcher. Every shack app (terminal, BBS, NET/ROM node, tools,
 * rig, remote) launches into its own surface (ShackAppSurface) and can be pinned to the nav rail.
 * APRS/APRScaching functionality lives OUTSIDE the shack: platform config in Settings (Connections
 * & sources / Network / Notifications), live stations on the map (layer toggle + station detail sheet).
 */
export function ShackPanel(props: {
  onClose: () => void;
  apps: ShackApp[];
  pinned: readonly PinId[];
  onLaunchApp: (id: ShackAppId) => void;
  onTogglePin: (id: ShackAppId) => void;
}) {
  return (
    <Panel
      title={
        <>
          <Icon name="antenna" cp437="" className="lead-ic" />
          Shack
        </>
      }
      onClose={props.onClose}
    >
      <p className="muted">
        Your <strong>field station</strong>: these apps drive a radio straight from this browser (Web Serial / Bluetooth
        / audio) or run on the platform — so you can operate off-grid with just a laptop and a rig, no server box.
        Launch one, or pin it to the left rail. <InfoTip text={TERMS.shack} label="What is the Shack?" />
      </p>

      <div className="shack-apps" role="list">
        {props.apps.map((app) => {
          const pinned = props.pinned.includes(app.id);
          return (
            <div key={app.id} className="shack-app" role="listitem">
              <Button className="shack-app-launch" onClick={() => props.onLaunchApp(app.id)}>
                <Icon name={app.icon} size={22} />
                <span className="shack-app-t">
                  <span className="shack-app-label">
                    {app.label}
                    {app.sysop && (
                      <Hint text="For the instance's operator only: it runs this instance's own radio box">
                        <span className="shack-app-op"> · operator</span>
                      </Hint>
                    )}
                  </span>
                  <span className="shack-app-blurb muted">{app.blurb}</span>
                </span>
              </Button>
              <Button
                variant="icon"
                className={`shack-pin${pinned ? " on" : ""}`}
                aria-pressed={pinned}
                hint={pinned ? `Unpin ${app.label} from the rail` : `Pin ${app.label} to the rail`}
                onClick={() => props.onTogglePin(app.id)}
              >
                <Icon name={pinned ? "pin-off" : "pin"} size={16} />
              </Button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
