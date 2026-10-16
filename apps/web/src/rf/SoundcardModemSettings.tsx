// SPDX-License-Identifier: AGPL-3.0-or-later
import { Advanced, Row, Segmented } from "../ui/index.js";
import { radioLink, useRadioLink } from "./RadioLinkHost.js";
import type { AudioDemod } from "./soundcardModem.js";

/**
 * My radio → Advanced: which modem the soundcard links run. Direwolf's (the default) also decodes FX.25 and IL2P;
 * the built-in one is the fallback, and runs by itself when Direwolf's module does not load.
 */
export function SoundcardModemSettings() {
  const { audioDemod, link } = useRadioLink();
  const audioLive = link === "audio" || link === "hf";
  return (
    <Advanced label="Advanced: soundcard modem">
      <Row
        label="Modem"
        help={
          audioLive
            ? "Takes effect when the soundcard connects again."
            : "Direwolf also decodes FX.25 and IL2P. The built-in modem decodes plain AX.25 only."
        }
      >
        <Segmented<AudioDemod>
          label="Soundcard modem"
          value={audioDemod}
          onChange={(d) => radioLink.setAudioDemod(d)}
          options={[
            { value: "direwolf", label: "Direwolf" },
            { value: "builtin", label: "Built-in" },
          ]}
        />
      </Row>
    </Advanced>
  );
}
