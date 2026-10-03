// SPDX-License-Identifier: AGPL-3.0-or-later
import { getNearRadio, setNearRadio } from "../api.js";
import { Group, useToast, useLoad } from "../ui/index.js";

/**
 * Settings → Near-cache radio message: the opt-in to a short APRS message from the instance's service call when
 * the player's own station is heard near a cache, for hunting without the app. Off by default, and only a
 * verified callsign can turn it on, since the instance transmits to it.
 */
export function NearRadioSettings(props: { verified: boolean }) {
  const toast = useToast();
  const { data, setData } = useLoad<{ on: boolean }>(getNearRadio, []);
  const on = !!data?.on;
  return (
    <Group
      title="Near-cache radio message"
      status={on ? "on" : props.verified ? "off" : "needs verification"}
      defaultOpen={false}
      master={{
        on,
        disabled: !data || (!props.verified && !on),
        set: (v) => {
          setNearRadio(v)
            .then((r) => {
              setData(r);
              toast(r.on ? "Your radio gets a message near a cache" : "No more near-cache messages to your radio");
            })
            .catch(() => toast("Couldn't save this preference — try again"));
        },
      }}
      reason={
        props.verified
          ? "Switch on for an APRS message to your radio when it is heard on foot near a cache."
          : "Verify your callsign to get a radio message near a cache."
      }
    >
      <p className="muted">
        A message to your station when it is heard on foot within 150 m of a cache, for example{" "}
        <span className="mono">Near AC-1234 Landhaus courtyard 40m NE. Reply FOUND AC-1234</span>. You can also send{" "}
        <span className="mono">NEAR ON</span> or <span className="mono">NEAR OFF</span> from your radio.
      </p>
    </Group>
  );
}
