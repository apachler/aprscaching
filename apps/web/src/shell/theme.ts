// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The theme on the document: the `data-theme` attribute the tokens key off, the CRT flag, and the browser's
 * `theme-color`, kept in step with the Appearance setting and, for "auto", with the system's colour scheme as
 * it changes. index.html sets the attribute before the first paint, main.tsx applies the rest at start, and
 * Platform re-applies it when the setting changes. The web manifest keeps the brand colour: it is what an
 * installed app shows on its splash screen, before any theme is known.
 */
import { resolveCrt, resolveTheme, type LocaleSettings, type ResolvedTheme } from "../format.js";
import { tokenHex } from "./tokenColor.js";

/** The slice of `window.matchMedia` the watcher uses (a test passes its own). */
type MatchMedia = (query: string) => {
  matches: boolean;
  addEventListener(type: "change", fn: () => void): void;
  removeEventListener(type: "change", fn: () => void): void;
};

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function prefersDark(mm: MatchMedia | undefined): boolean {
  try {
    return mm ? !mm(LIGHT_QUERY).matches : true;
  } catch {
    return true;
  }
}

/**
 * Point the browser chrome (`theme-color`) at the applied theme's top bar. index.html carries one meta per
 * system scheme for the first paint; an explicit theme overrides both, and "auto" leaves each on its scheme.
 */
function applyThemeColor(theme: LocaleSettings["theme"]): void {
  if (typeof document === "undefined" || !document.body) return;
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  for (const m of metas) {
    if (!m.dataset.scheme) m.dataset.scheme = m.content; // the shipped value, for "auto"
    m.content = theme === "auto" ? m.dataset.scheme : tokenHex("--topbar-bg", m.dataset.scheme);
  }
}

/** Apply SETTINGS to the document root now; returns the theme applied. */
export function applyTheme(
  settings: LocaleSettings,
  mm: MatchMedia | undefined = globalThis.matchMedia?.bind(globalThis),
): ResolvedTheme {
  const applied = resolveTheme(settings.theme, prefersDark(mm));
  const root = document.documentElement;
  root.dataset.theme = applied;
  root.dataset.crt = resolveCrt(settings);
  applyThemeColor(settings.theme);
  return applied;
}

/**
 * Follow the system's colour scheme while SETTINGS say "auto": re-apply on every change. Returns the
 * unsubscribe; a no-op for an explicit theme.
 */
export function watchSystemTheme(
  settings: LocaleSettings,
  mm: MatchMedia | undefined = globalThis.matchMedia?.bind(globalThis),
  onApplied?: (t: ResolvedTheme) => void,
): () => void {
  if (settings.theme !== "auto" || !mm) return () => {};
  let query: ReturnType<MatchMedia>;
  try {
    query = mm(LIGHT_QUERY);
  } catch {
    return () => {};
  }
  const onChange = () => {
    const applied = applyTheme(settings, mm);
    onApplied?.(applied);
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
