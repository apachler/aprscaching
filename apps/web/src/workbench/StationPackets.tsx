// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { getStationPackets, type RawPacket } from "../api.js";
import { useFmt } from "../format.js";

/**
 * Recent raw frames heard from a station — a workbench-only diagnostic. Loads on
 * demand (the cacher surface never sees raw packets); the data is a short, TTL-pruned ring server-side
 * so it's inherently bounded. Shows the reconstructed TNC2 line, monospaced.
 */
export function StationPackets(props: { callsign: string }) {
  const [open, setOpen] = useState(false);
  const [packets, setPackets] = useState<RawPacket[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fmt = useFmt();

  useEffect(() => { setPackets(null); setErr(null); }, [props.callsign]);

  useEffect(() => {
    if (!open || packets) return;
    const ac = new AbortController();
    getStationPackets(props.callsign, 50, ac.signal)
      .then((r) => setPackets(r.packets)).catch((e) => setErr((e as Error).message));
    return () => ac.abort();
  }, [open, packets, props.callsign]);

  return (
    <div className="station-packets">
      <button className="link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Raw packets
      </button>
      {open && (
        err ? <p className="muted">Couldn't load packets: {err}</p>
        : !packets ? <p className="muted">Loading…</p>
        : packets.length === 0 ? <p className="muted">No raw frames in the retention window.</p>
        : <ul className="logs rf-rx mt-1">{packets.map((pk, i) => (
            <li key={`${pk.ts}-${i}`}>
              <span className="muted">{fmt.ago(pk.ts)} · {pk.heardVia ?? "—"}{pk.port ? ` · ${pk.port}` : ""}</span>
              <div className="comment mono">{pk.tnc2}</div>
            </li>
          ))}</ul>
      )}
    </div>
  );
}
