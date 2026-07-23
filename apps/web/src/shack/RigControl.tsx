// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { APRS_FREQ, type CatRig } from "@aprscaching/aprs";
import { cat, catSupported, useCatConnected, type RigProfile } from "../rf/cat.js";
import { useToast } from "../ui/index.js";

/**
 * Rig control: connect a transceiver over Web Serial CAT and one-click tune it — the
 * APRS calling frequency, or any frequency. Tuning only sets the VFO (no transmit), so it isn't
 * gated on callsign control-verification. Spot cards reuse the same shared controller to tune to a
 * spot's freq+mode. Chromium-only.
 */
const RIGS: { id: CatRig; label: string; baud: number }[] = [
  { id: "kenwood", label: "Kenwood / modern Yaesu (ASCII)", baud: 38400 },
  { id: "icom", label: "Icom (CI-V)", baud: 19200 },
  { id: "yaesu-bin", label: "Yaesu classic (FT-817/857/897)", baud: 4800 },
];
const BAUDS = [4800, 9600, 19200, 38400, 57600, 115200];

export function RigControl() {
  const toast = useToast();
  const connected = useCatConnected();
  const [rig, setRig] = useState<CatRig>("kenwood");
  const [baud, setBaud] = useState(38400);
  const [addr, setAddr] = useState("94"); // CI-V hex address
  const [mhz, setMhz] = useState("");
  const [busy, setBusy] = useState(false);

  if (!catSupported())
    return (
      <p className="muted fine">
        CAT control needs Web Serial — use Chromium on desktop. Other browsers can use a Hamlib{" "}
        <span className="mono">rigctld</span> companion.
      </p>
    );

  async function connect() {
    setBusy(true);
    try {
      const profile: RigProfile = { rig, baud, icomAddr: parseInt(addr, 16) || 0x94 };
      await cat.connect(profile);
      toast("Rig connected");
    } catch (e) {
      const m = (e as Error).message || "";
      if (!/No port selected|cancel|NotFound/i.test(m)) toast(`Could not connect: ${m}`);
    } finally {
      setBusy(false);
    }
  }
  async function tune(hz: number, mode?: string) {
    setBusy(true);
    try {
      await cat.tune(hz, mode);
      toast(`Tuned to ${(hz / 1e6).toFixed(3)} MHz`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function tuneManual() {
    const hz = Math.round(parseFloat(mhz) * 1e6);
    if (!Number.isFinite(hz) || hz <= 0) {
      toast("Enter a frequency in MHz");
      return;
    }
    void tune(hz);
  }

  return (
    <div className="rigctl">
      {!connected ? (
        <>
          <label>
            Radio{" "}
            <select
              value={rig}
              onChange={(e) => {
                const r = e.target.value as CatRig;
                setRig(r);
                setBaud(RIGS.find((x) => x.id === r)!.baud);
              }}
            >
              {RIGS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <label>
              Baud{" "}
              <select value={baud} onChange={(e) => setBaud(+e.target.value)}>
                {BAUDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            {rig === "icom" && (
              <label>
                CI-V addr{" "}
                <input
                  className="mono field-xs"
                  value={addr}
                  onChange={(e) => setAddr(e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 2))}
                />
              </label>
            )}
          </div>
          <div className="row end">
            <button className="primary" onClick={connect} disabled={busy}>
              Connect rig
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row gap-2">
            <button onClick={() => tune(APRS_FREQ.eu, "FM")} disabled={busy}>
              144.800 (EU APRS)
            </button>
            <button onClick={() => tune(APRS_FREQ.na, "FM")} disabled={busy}>
              144.390 (NA APRS)
            </button>
          </div>
          <div className="row gap-2">
            <input
              className="mono"
              inputMode="decimal"
              placeholder="MHz, e.g. 14.074"
              value={mhz}
              onChange={(e) => setMhz(e.target.value)}
            />
            <button onClick={tuneManual} disabled={busy}>
              Tune
            </button>
          </div>
          <div className="row end">
            <button className="danger" onClick={() => cat.disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}
