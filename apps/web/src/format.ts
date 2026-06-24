/**
 * format.ts — locale & units. The server speaks SI (metres, knots, °C, unix seconds); the client
 * presents it in the user's locale + unit system. Settings default to the browser locale/timezone
 * and a metric/imperial guess from the locale region, with a manual override persisted in
 * localStorage. A React context exposes ready-made formatters so any component can render
 * locale-correct numbers, dates, distances, speeds, temperatures, etc.
 */
import { createContext, useContext } from "react";

export interface LocaleSettings {
  locale: string;    // BCP-47 (e.g. "de-AT"); "" => browser default
  timeZone: string;  // IANA (e.g. "Europe/Vienna"); "" => browser default
  units: "metric" | "imperial";
}

const KEY = "acs.locale";
const IMPERIAL_REGIONS = new Set(["US", "LR", "MM"]); // United States, Liberia, Myanmar

export function browserLocale(): string {
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
function unitsForLocale(locale: string): "metric" | "imperial" {
  try {
    const region = new Intl.Locale(locale).maximize().region ?? "";
    return IMPERIAL_REGIONS.has(region) ? "imperial" : "metric";
  } catch { return "metric"; }
}

export function defaultSettings(): LocaleSettings {
  const locale = browserLocale();
  return { locale: "", timeZone: "", units: unitsForLocale(locale) };
}
export function loadSettings(): LocaleSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<LocaleSettings>) };
  } catch { /* ignore */ }
  return defaultSettings();
}
export function saveSettings(s: LocaleSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- formatters
export interface Formatters {
  settings: LocaleSettings;
  resolvedLocale: string;
  resolvedTimeZone: string;
  num: (n: number, max?: number) => string;
  date: (ts: number) => string;
  time: (ts: number) => string;
  dateTime: (ts: number) => string;
  ago: (ts: number) => string;
  distance: (m: number) => string;
  speed: (kn: number) => string;
  altitude: (m: number) => string;
  temp: (c: number) => string;
  coord: (lat: number, lon: number) => string;
}

const KN_TO_KMH = 1.852, KN_TO_MPH = 1.150779, M_TO_FT = 3.28084, M_TO_MI = 0.000621371;

export function makeFormatters(settings: LocaleSettings): Formatters {
  const locale = settings.locale || browserLocale();
  const timeZone = settings.timeZone || browserTimeZone();
  const imperial = settings.units === "imperial";
  const nf = (max: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: max });

  const num = (n: number, max = 1) => nf(max).format(n);
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone });
  const timeFmt = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone });
  const dtFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone });

  const ago = (ts: number) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    if (s < 90) return rtf.format(-s, "second");
    if (s < 5400) return rtf.format(-Math.round(s / 60), "minute");
    if (s < 172800) return rtf.format(-Math.round(s / 3600), "hour");
    return rtf.format(-Math.round(s / 86400), "day");
  };

  const distance = (m: number) => {
    if (imperial) {
      const mi = m * M_TO_MI;
      return mi < 0.19 ? `${num(Math.round(m * M_TO_FT), 0)} ft` : `${num(mi, mi < 10 ? 2 : 1)} mi`;
    }
    return m < 1000 ? `${num(Math.round(m), 0)} m` : `${num(m / 1000, m < 10000 ? 2 : 1)} km`;
  };
  const speed = (kn: number) => imperial ? `${num(kn * KN_TO_MPH)} mph` : `${num(kn * KN_TO_KMH)} km/h`;
  const altitude = (m: number) => imperial ? `${num(Math.round(m * M_TO_FT), 0)} ft` : `${num(Math.round(m), 0)} m`;
  const temp = (c: number) => imperial ? `${num(c * 9 / 5 + 32, 0)} °F` : `${num(c, 0)} °C`;
  const coord = (lat: number, lon: number) => `${num(Math.abs(lat), 5)}°${lat >= 0 ? "N" : "S"}, ${num(Math.abs(lon), 5)}°${lon >= 0 ? "E" : "W"}`;

  return {
    settings, resolvedLocale: locale, resolvedTimeZone: timeZone,
    num,
    date: (ts) => dateFmt.format(ts * 1000),
    time: (ts) => timeFmt.format(ts * 1000),
    dateTime: (ts) => dtFmt.format(ts * 1000),
    ago, distance, speed, altitude, temp, coord,
  };
}

export const FormatContext = createContext<Formatters>(makeFormatters(defaultSettings()));
export const useFmt = (): Formatters => useContext(FormatContext);
