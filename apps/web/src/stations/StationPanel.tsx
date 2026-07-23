// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import type maplibregl from "maplibre-gl";
import { getStation, createStation, type StationDetail } from "../api.js";
import { ROLE_META } from "../stationRoles.js";
import type { StationRole } from "@aprscaching/shared";
import { useFmt } from "../format.js";
import { Panel, Badge, ErrorState, Ico, useToast } from "../ui/index.js";
import { TrackReplay } from "../shack/TrackReplay.js";
import { StationGraphs } from "../shack/StationGraphs.js";
import { StationPackets } from "../shack/StationPackets.js";

/**
 * StationPanel — the live-station inspector, opened when a station pin is tapped on the map. Shows the
 * station's symbol/roles/telemetry, track replay, weather + packet graphs, and lets you adopt it into
 * "my stations". Its own surface now (APRS functionality lives on the map + its detail sheet, not in
 * the shack).
 */
export function StationPanel(props: {
  callsign: string;
  picked: string;
  map: maplibregl.Map | null;
  onFly: (lat: number, lon: number) => void;
  onClose: () => void;
}) {
  const fmt = useFmt();
  const toast = useToast();
  const [station, setStation] = useState<StationDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setStation(null);
    setErr(null);
    getStation(props.picked)
      .then((r) => {
        if (live) setStation(r.station);
      })
      .catch((e) => {
        if (live) setErr((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [props.picked]);

  const retry = () => {
    setErr(null);
    setStation(null);
    getStation(props.picked)
      .then((r) => setStation(r.station))
      .catch((e) => setErr((e as Error).message));
  };
  return (
    <Panel
      title={
        <>
          <Ico e="📡 " />
          <span className="mono">{props.picked}</span>
        </>
      }
      onClose={props.onClose}
    >
      {err ? (
        <ErrorState onRetry={retry}>Couldn't load {props.picked}.</ErrorState>
      ) : !station ? (
        <p className="muted">Loading station…</p>
      ) : (
        <div className="logform">
          <div className="muted">
            {station.symbol ?? "—"} · last heard {fmt.ago(station.lastSeen)}
          </div>
          {station.roles?.length ? (
            <div className="badges mt-1">
              {station.roles.map((r) => (
                <Badge key={r}>{ROLE_META[r as StationRole]?.label ?? r}</Badge>
              ))}
            </div>
          ) : null}
          {station.comment && <div className="comment">{station.comment}</div>}
          <div className="muted mt-1">
            {station.speedKn != null && station.speedKn > 0
              ? `${fmt.speed(station.speedKn)} @ ${station.course ?? 0}° · `
              : ""}
            {station.altitudeM != null ? `${fmt.altitude(station.altitudeM)} · ` : ""}
            {station.packets} pkts · {station.track.length} track pts
          </div>
          {station.wx && (
            <div className="wx">
              {station.wx.tempC != null && (
                <>
                  <Ico e="🌡 " c="T " />
                  {fmt.temp(station.wx.tempC)} ·{" "}
                </>
              )}
              <Ico e="💧 " c="RH " />
              {station.wx.humidity ?? "—"}% ·{" "}
              {station.wx.windKn != null && (
                <>
                  <Ico e="🌬 " c="WND " />
                  {fmt.speed(station.wx.windKn)} ·{" "}
                </>
              )}
              {station.wx.pressureHpa ?? "—"} hPa
            </div>
          )}
          <div className="row between mt-3">
            {props.callsign.length >= 3 ? (
              <button
                onClick={async () => {
                  try {
                    await createStation({ callsign: station.callsign });
                    toast(`${station.callsign} added to your stations`);
                  } catch (e) {
                    toast((e as Error).message);
                  }
                }}
              >
                + Add to my stations
              </button>
            ) : (
              <span />
            )}
            <button onClick={() => props.onFly(station.lat, station.lon)}>Fly to</button>
          </div>
          <TrackReplay map={props.map} callsign={station.callsign} />
          <StationGraphs callsign={station.callsign} />
          <StationPackets callsign={station.callsign} />
        </div>
      )}
    </Panel>
  );
}
