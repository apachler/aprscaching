// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * format.ts — locale & units. The server speaks SI (metres, knots, °C, unix seconds); the client
 * presents it in the user's locale + unit system. Settings default to the browser locale/timezone
 * and a metric/imperial guess from the time zone (else the locale region), with a manual override persisted in
 * localStorage. A React context exposes ready-made formatters so any component can render
 * locale-correct numbers, dates, distances, speeds, temperatures, etc.
 */
import { createContext, useContext } from "react";

/**
 * The Appearance setting: "dark" (the default), "light", "auto" (dark or light, following the system and
 * switching live) or "phosphor" (the late-90s green-phosphor flip).
 */
export type Theme = "auto" | "light" | "dark" | "phosphor";
/** What the token layer applies: the `data-theme` attribute on the document root. */
export type ResolvedTheme = "dark" | "light" | "phosphor";
export interface LocaleSettings {
  locale: string; // BCP-47 (e.g. "de-AT"); "" => browser default
  timeZone: string; // IANA (e.g. "Europe/Vienna"); "" => browser default
  units: "metric" | "imperial";
  theme: Theme;
  /** Opt-in CRT flourish (scanline + phosphor glow), only meaningful in Phosphor; off by default
   * . */
  crt: boolean;
}

/** The `data-crt` value for the document root: the scanline/glow overlay is applied ONLY when the
 *  Phosphor theme is active AND the user opted in — Modern never gets it. */
export function resolveCrt(s: LocaleSettings): "on" | "off" {
  return s.theme === "phosphor" && s.crt ? "on" : "off";
}

/** The token set for THEME: "auto" follows the system's colour scheme (PREFERS_DARK), the rest are themselves. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "auto") return prefersDark ? "dark" : "light";
  return theme;
}
/** Whether the system asks for a dark colour scheme; true where it cannot say. */
export function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === "function" ? !matchMedia("(prefers-color-scheme: light)").matches : true;
  } catch {
    return true;
  }
}
/** Coerce any stored theme value to a theme, never throwing. "modern" (the name of the dark theme in the
 *  settings of older versions) is dark, "cogmind" is Phosphor's old alias, and anything unknown is dark. */
export function normalizeTheme(t: unknown): Theme {
  if (t === "auto" || t === "light" || t === "dark" || t === "phosphor") return t;
  if (t === "cogmind") return "phosphor";
  return "dark";
}

const KEY = "acs.locale";
const IMPERIAL_REGIONS = new Set(["US", "LR", "MM"]); // United States, Liberia, Myanmar

const FALLBACK_LOCALE = "en-US";

function canonical(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/**
 * A locale tag every `Intl` constructor accepts. Browsers can report POSIX-style tags (`en-US@posix`,
 * `en_US.UTF-8`, `C`) that `Intl` rejects with a RangeError, so TAG is canonicalised, then retried without
 * its `@modifier` / `.codeset` suffix and with `_` read as `-`, and otherwise falls back to `en-US`.
 */
export function canonicalLocale(tag: string | undefined | null): string {
  const raw = (tag ?? "").trim();
  if (!raw) return FALLBACK_LOCALE;
  const stripped = raw.replace(/[@.].*$/s, "").replace(/_/g, "-");
  return canonical(raw) ?? (stripped ? canonical(stripped) : undefined) ?? FALLBACK_LOCALE;
}

export function browserLocale(): string {
  return canonicalLocale(typeof navigator !== "undefined" ? navigator.language : undefined);
}
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
/** The time zones of the imperial regions: the United States, Liberia and Myanmar. */
const IMPERIAL_ZONE =
  /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Adak|Boise|Detroit|Juneau|Sitka|Metlakatla|Nome|Yakutat|Menominee|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/Honolulu|US\/.+|Africa\/Monrovia|Asia\/(Yangon|Rangoon))$/;

/**
 * The unit system to start from: metric unless the device is in the United States, Liberia or Myanmar. The time
 * zone says where the device is, so it decides when it names a place; a language setting (en-US on a laptop in
 * Vienna) says less. Without a place in the zone (UTC, none), the locale's region decides. Pure.
 */
export function unitsFor(locale: string, timeZone: string): "metric" | "imperial" {
  if (/^[A-Za-z]+\/[A-Za-z_]/.test(timeZone)) return IMPERIAL_ZONE.test(timeZone) ? "imperial" : "metric";
  try {
    const region = new Intl.Locale(locale).maximize().region ?? "";
    return IMPERIAL_REGIONS.has(region) ? "imperial" : "metric";
  } catch {
    return "metric";
  }
}

function defaultSettings(): LocaleSettings {
  return { locale: "", timeZone: "", units: unitsFor(browserLocale(), browserTimeZone()), theme: "dark", crt: false };
}
export function loadSettings(): LocaleSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = { ...defaultSettings(), ...(JSON.parse(raw) as Partial<LocaleSettings>) };
      s.theme = normalizeTheme(s.theme);
      return s;
    }
  } catch {
    /* ignore */
  }
  return defaultSettings();
}
export function saveSettings(s: LocaleSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
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

const KN_TO_KMH = 1.852,
  KN_TO_MPH = 1.150779,
  M_TO_FT = 3.28084,
  M_TO_MI = 0.000621371;

export function makeFormatters(settings: LocaleSettings): Formatters {
  const locale = settings.locale ? canonicalLocale(settings.locale) : browserLocale();
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
  const speed = (kn: number) => (imperial ? `${num(kn * KN_TO_MPH)} mph` : `${num(kn * KN_TO_KMH)} km/h`);
  const altitude = (m: number) => (imperial ? `${num(Math.round(m * M_TO_FT), 0)} ft` : `${num(Math.round(m), 0)} m`);
  const temp = (c: number) => (imperial ? `${num((c * 9) / 5 + 32, 0)} °F` : `${num(c, 0)} °C`);
  const coord = (lat: number, lon: number) =>
    `${num(Math.abs(lat), 5)}°${lat >= 0 ? "N" : "S"}, ${num(Math.abs(lon), 5)}°${lon >= 0 ? "E" : "W"}`;

  return {
    settings,
    resolvedLocale: locale,
    resolvedTimeZone: timeZone,
    num,
    date: (ts) => dateFmt.format(ts * 1000),
    time: (ts) => timeFmt.format(ts * 1000),
    dateTime: (ts) => dtFmt.format(ts * 1000),
    ago,
    distance,
    speed,
    altitude,
    temp,
    coord,
  };
}

export const FormatContext = createContext<Formatters>(makeFormatters(defaultSettings()));
export const useFmt = (): Formatters => useContext(FormatContext);
/** The applied theme, reactively: the setting from context, with "auto" resolved against the system scheme.
 *  Phosphor draws its CP437 glyphs on this (see ui/Icon). */
export const useTheme = (): ResolvedTheme =>
  resolveTheme(normalizeTheme(useContext(FormatContext).settings.theme), systemPrefersDark());
