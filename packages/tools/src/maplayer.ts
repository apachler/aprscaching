// SPDX-License-Identifier: MIT
/**
 * maplayer.ts — the declarative map-layer a `map`-capability Tool contributes (docs/28 §6 — the last
 * capability that had no host surface). A tool NEVER touches MapLibre; it emits a typed list of points and
 * the host renders them as markers on the `map` surface with theme tokens. Kept small + serialisable so an
 * imported (sandboxed) tool can emit it too — same posture as the panel model.
 */
import type { PanelTone } from "./panel.js";

/** One marker: a position + an optional short label/glyph + a tone (mapped by the host to a token). */
export interface MapPoint { lat: number; lon: number; label?: string; glyph?: string; tone?: PanelTone }
/** A tool's map layer: a stable id + its points. Replaced wholesale on each setMapLayer. */
export interface MapLayerSpec { id: string; points: MapPoint[] }

const TONES = new Set<PanelTone>(["default", "muted", "accent", "ok", "warn", "bad"]);
const num = (x: unknown): number | null => (typeof x === "number" && isFinite(x) ? x : null);
const str = (x: unknown, cap: number): string | undefined => (typeof x === "string" ? x.slice(0, cap) : undefined);

/** Coerce an untrusted map layer (from an imported tool) into a safe spec — bounds points + fields. */
export function sanitizeMapLayer(input: unknown): MapLayerSpec {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const id = (typeof o.id === "string" ? o.id : "layer").slice(0, 64) || "layer";
  const raw = Array.isArray(o.points) ? o.points.slice(0, 2000) : [];
  const points: MapPoint[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const d = p as Record<string, unknown>;
    const lat = num(d.lat), lon = num(d.lon);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    points.push({ lat, lon, label: str(d.label, 40), glyph: str(d.glyph, 2), tone: TONES.has(d.tone as PanelTone) ? (d.tone as PanelTone) : undefined });
  }
  return { id, points };
}
