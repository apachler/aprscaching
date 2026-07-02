import { useEffect, useRef, useState } from "react";
import { getStationSeries, type StationSeries } from "../api.js";

/**
 * Telemetry & weather graphs for a station (docs/26 Stage 0.1). uPlot is heavy-ish (canvas + its own
 * CSS), so it and the data are loaded ONLY when the operator opens this disclosure — the cacher
 * surface never pays for it (css.md: lazy, no charting on the default view). uPlot doesn't animate, so
 * it's reduced-motion-safe by construction. Colours come from the theme tokens, not hard-coded hues.
 */
type UPlot = typeof import("uplot");

function tok(name: string, fallback: string): string {
  if (typeof getComputedStyle === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

interface SeriesDef { label: string; color: string; unit: string; data: (number | null)[] }

/** Build one uPlot chart from aligned x (sec) + a few y series; returns a disposer. */
function makeChart(
  U: UPlot, el: HTMLDivElement, title: string, xs: number[], defs: SeriesDef[],
): () => void {
  const axis = tok("--text", "#ccc"), grid = tok("--muted", "#8884");
  const opts = {
    title, width: el.clientWidth || 320, height: 120,
    cursor: { show: true }, legend: { show: true },
    scales: { x: { time: true } },
    axes: [
      { stroke: axis, grid: { stroke: grid, width: 0.5 }, ticks: { stroke: grid } },
      { stroke: axis, grid: { stroke: grid, width: 0.5 }, ticks: { stroke: grid }, size: 44 },
    ],
    series: [
      {},
      ...defs.map((d) => ({ label: `${d.label} (${d.unit})`, stroke: d.color, width: 1.5, points: { show: false } })),
    ],
  };
  const data = [xs, ...defs.map((d) => d.data)] as unknown as (number | null)[][];
  const u = new U(opts as ConstructorParameters<UPlot>[0], data as ConstructorParameters<UPlot>[1], el);
  const ro = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => u.setSize({ width: el.clientWidth || 320, height: 120 }))
    : null;
  ro?.observe(el);
  return () => { ro?.disconnect(); u.destroy(); };
}

export function StationGraphs(props: { callsign: string }) {
  const [open, setOpen] = useState(false);
  const [series, setSeries] = useState<StationSeries | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);

  // Fetch the windowed series the first time the panel is opened.
  useEffect(() => {
    if (!open || series) return;
    const ac = new AbortController();
    getStationSeries(props.callsign, 86400, ac.signal).then(setSeries).catch((e) => setErr((e as Error).message));
    return () => ac.abort();
  }, [open, series, props.callsign]);

  // Reset when the inspected station changes.
  useEffect(() => { setSeries(null); setErr(null); }, [props.callsign]);

  // Render the charts once we have data + the container; dynamic-import uPlot here.
  useEffect(() => {
    if (!open || !series || !host.current) return;
    let disposers: (() => void)[] = [];
    let live = true;
    (async () => {
      const [mod] = await Promise.all([
        import("uplot"),
        import("uplot/dist/uPlot.min.css"),
      ]);
      const U: UPlot = (mod as { default?: UPlot }).default ?? (mod as unknown as UPlot);
      if (!live || !host.current) return;
      const el = host.current;
      el.innerHTML = "";
      const add = (title: string, xs: number[], defs: SeriesDef[]) => {
        const nonEmpty = defs.filter((d) => d.data.some((v) => v != null));
        if (!xs.length || !nonEmpty.length) return;
        const div = document.createElement("div");
        div.className = "station-graph";
        el.appendChild(div);
        disposers.push(makeChart(U, div, title, xs, nonEmpty));
      };

      const wxX = series.wx.map((p) => p.ts);
      add("Temperature", wxX, [{ label: "temp", color: tok("--bad", "#e55"), unit: "°C", data: series.wx.map((p) => p.tempC) }]);
      add("Humidity", wxX, [
        { label: "humidity", color: tok("--tier-b", "#59f"), unit: "%", data: series.wx.map((p) => p.humidity) },
      ]);
      add("Pressure", wxX, [{ label: "pressure", color: tok("--accent", "#0bd"), unit: "hPa", data: series.wx.map((p) => p.pressureHpa) }]);
      add("Wind", wxX, [
        { label: "wind", color: tok("--accent", "#0bd"), unit: "kn", data: series.wx.map((p) => p.windKn) },
        { label: "gust", color: tok("--warn", "#fb0"), unit: "kn", data: series.wx.map((p) => p.gustKn) },
      ]);

      const mX = series.motion.map((p) => p.ts);
      add("Speed", mX, [{ label: "speed", color: tok("--tier-a", "#3c6"), unit: "kn", data: series.motion.map((p) => p.speedKn) }]);
      add("Altitude", mX, [{ label: "altitude", color: tok("--accent", "#0bd"), unit: "m", data: series.motion.map((p) => p.altitudeM) }]);
    })();
    return () => { live = false; disposers.forEach((d) => d()); };
  }, [open, series]);

  const has = series && (series.wx.length || series.motion.length);

  return (
    <div className="station-graphs">
      <button className="link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Graphs (24h)
      </button>
      {open && (
        err ? <p className="muted">Couldn't load graphs: {err}</p>
        : !series ? <p className="muted">Loading…</p>
        : !has ? <p className="muted">No telemetry or weather in the last 24h.</p>
        : <div ref={host} className="graph-host" />
      )}
    </div>
  );
}
