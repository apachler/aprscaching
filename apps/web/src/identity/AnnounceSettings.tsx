// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAnnounce, setAnnounce } from "../api.js";
import { Group, useToast, useLoad } from "../ui/index.js";

/**
 * Settings → Announce finds: the opt-in to sending each verified find to APRS-IS as a status message from the
 * finder's callsign. Off by default, and only a verified callsign can turn it on.
 */
export function AnnounceSettings(props: { verified: boolean }) {
  const toast = useToast();
  const { data, setData } = useLoad<{ on: boolean }>(getAnnounce, []);
  const on = !!data?.on;
  return (
    <Group
      title="Announce finds"
      status={on ? "on" : props.verified ? "off" : "needs verification"}
      defaultOpen={false}
      master={{
        on,
        disabled: !data || (!props.verified && !on),
        set: (v) => {
          setAnnounce(v)
            .then((r) => {
              setData(r);
              toast(r.on ? "Your finds are announced on APRS-IS" : "Your finds are no longer announced");
            })
            .catch(() => toast("Couldn't save this preference — try again"));
        },
      }}
      reason={
        props.verified ? "Off: your finds stay in the app." : "Verify your callsign to announce your finds on APRS-IS."
      }
    >
      <p className="muted">
        Each verified find goes to APRS-IS as a short status message from your callsign, for example{" "}
        <span className="mono">Found AC-1234 (Rover on the ridge) via {location.hostname}</span>.
      </p>
    </Group>
  );
}
