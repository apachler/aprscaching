# CSS Policy — when Claude Code MUST / SHOULD / MAY / WON'T use CSS over JavaScript

A decision rulebook for styling `apps/web`. Read this **before writing any CSS, choosing a
responsive strategy, adding an animation, or reaching for JavaScript to do something visual.**
Keywords follow RFC 2119: **MUST / MUST NOT (WON'T) / SHOULD / SHOULD NOT / MAY.**

## The one rule

> **CSS owns presentation, layout, and state-driven *appearance*. JavaScript owns behavior, data,
> and logic.** Reach for CSS first for anything visual or responsive. Reach for JS only when the
> thing is genuinely behavioral or data-driven. Never use a CSS *hack* that sacrifices semantics
> or accessibility, and never use JS to recompute what CSS can express declaratively.

This app is **mobile-first, used outdoors, and renders a MapLibre vector map**. That context sets
two hard constraints that override "because it's cool": **performance (we share the main thread /
GPU with the map)** and **accessibility (cachers log finds one-handed, sometimes with assistive
tech)**. Modern CSS is encouraged exactly where it *removes JavaScript and dependencies* — that is
the real benefit, not novelty.

---

## WHEN — quick decision table

| I need to… | Use | Not |
|---|---|---|
| Adapt a panel/sheet to the space **it** occupies (docked vs full-width) | **CSS container queries** | JS width measurement / viewport breakpoints |
| Adapt to the **viewport** (coarse layout, orientation) | CSS media queries | JS |
| Style an element based on its **contents or a child's state** | **CSS `:has()`** | JS class toggling |
| Derive hover/active/disabled tints, dark/light variants from a base color | **`color-mix()` / OKLCH / `light-dark()`** | hand-written palettes / JS |
| Keep a header/toolbar pinned while scrolling | **`position: sticky`** | JS scroll listeners |
| Transition appearance on a state change (open/close, selected) | **CSS transitions** | JS animation libs |
| Snap bottom-sheets to stops | **CSS `scroll-snap`** | JS drag math |
| Lay out aligned grids / cards | **CSS grid / subgrid** | JS / flex hacks |
| Fluid type & spacing | **`clamp()`** | JS resize handlers |
| Keep long lists cheap (Nearby/Logbook) | **`content-visibility` / `contain`** | virtualization *first* (add JS virtualization only if still slow) |
| Show/position a tooltip or menu | **`popover` + anchor positioning** (with fallback) | bespoke JS positioning when avoidable |
| Fetch data, hold app state, run the log flow, talk to the map/WS/Geolocation | **JavaScript / React** | CSS (impossible) |

---

## MUST use CSS (do not solve these in JS)

- **Responsive component layout MUST use container queries** (`container-type: inline-size` +
  `@container`) for anything that can appear in more than one slot (cache sheet, Nearby list,
  detail panel). The sheet/panel IA in `` depends on this.
- **Theming MUST be token-driven**, with dark/light via `color-scheme` + `light-dark()` (or a
  `[data-theme]` layer) — **no JS theme recomputation, no inline color math.**
- **State-driven appearance MUST use CSS** where the state is expressible in the DOM
  (`:hover`, `:focus-visible`, `:checked`, `:disabled`, `[aria-current]`, `:has()`). Don't toggle
  style-only classes from JS for these.
- **Sticky/pinned chrome MUST use `position: sticky`**, never scroll-event listeners.
- **Mobile viewport sizing MUST use `dvh`/`svh`** and **`env(safe-area-inset-*)`** (with
  `viewport-fit=cover`). The bottom tab bar and sheets MUST clear the mobile browser chrome and
  notch — this is non-negotiable for the field use case.
- **`prefers-reduced-motion` MUST be honored** — every transition/animation MUST have a
  reduced-motion path that removes or minimizes motion.

## SHOULD prefer CSS

- **SHOULD** use `clamp()` for fluid type/spacing instead of breakpoint step-downs.
- **SHOULD** use native nesting + `@layer` (cascade layers) for a maintainable token/system
  structure — no preprocessor required.
- **SHOULD** use `grid`/`subgrid` for alignment over nested flex hacks.
- **SHOULD** use `content-visibility: auto` / `contain` on long, off-screen lists before adding
  JS virtualization.
- **SHOULD** use `accent-color`, `text-wrap: balance/pretty`, and form/`field-sizing` niceties when
  they remove JS.
- **SHOULD** derive the **trust-tier and status palette** (A/B/C, green/amber/red) from base tokens
  via `color-mix()`/OKLCH so brightness stays even across hues (sunlight legibility).

## MAY use CSS (fine, in moderation)

- **MAY** use `backdrop-filter` on **one** small surface (e.g. a single active sheet) — see perf
  rules below.
- **MAY** use the **View Transitions API** for a *single, meaningful* transition (e.g. map→cache
  detail), reduced-motion-aware, never decorative.
- **MAY** use anchor positioning / `popover` for tooltips and menus **behind `@supports`** with a
  sane fallback.
- **MAY** use scroll-snap, `:target`, and `details/summary` for genuinely simple disclosure —
  provided accessibility is intact (see WON'T).

## WON'T — MUST NOT use CSS for these

- **MUST NOT** rebuild interactive widgets as CSS-only hacks** — no checkbox/`:target`-driven
  tabs, carousels, accordions, modals, or dropdowns. These break keyboard and screen-reader
  behavior. Use accessible components with real semantics + ARIA, styled by CSS.
- **MUST NOT** replace semantic elements with `div` + CSS** (no styled-div buttons/links/lists).
  Use `<button>`, `<a>`, `<ul>`, `<nav>`, `<dialog>` and style those.
- **MUST NOT** animate layout/paint-heavy properties over the map** — no animating `top/left/
  width/height/box-shadow/filter` on large or frequently-updating surfaces. Animate only
  **compositor-friendly** `transform` and `opacity`.
- **MUST NOT** blanket the map in `backdrop-filter`/large blurs** — one frosted sheet max; never
  blur full-screen layers stacked over MapLibre (repaint cost + battery).
- **MUST NOT** ship scroll-driven / cinematic animations** (`animation-timeline: scroll()/view()`,
  parallax, scroll-spectacle) on the cacher surface. Showcase, not value; competes with map
  rendering. (A subtle, reduced-motion-aware touch in a non-map view MAY be allowed.)
- **MUST NOT** rely on a modern feature without support-guarding it** if it's load-bearing — gate
  with `@supports` and provide a usable fallback (see baseline below).

---

## MUST NOT use JavaScript where CSS suffices (the inverse antipatterns)

- **MUST NOT** add `resize`/`scroll` listeners or `ResizeObserver` to do what `@container`,
  media queries, or `position: sticky` already do.
- **MUST NOT** pull in a JS animation library for simple state transitions — CSS transitions first;
  reserve JS/Motion only for gesture-driven or physics-based interactions that CSS can't express.
- **MUST NOT** compute colors/tints/spacing in JS that `color-mix()`/`clamp()` can derive.
- **MUST NOT** read layout in render loops (`getBoundingClientRect` on scroll/resize) for styling
  outcomes CSS can declare.
- **MUST NOT** write inline styles for values that belong in `ui/tokens.css`.

---

## Browser baseline & guarding

- Our hardware features (Web Serial / Web Bluetooth) already pin field use to **recent Chromium**,
  so most modern CSS here is safe. **But:** the *read-only / browse* experience SHOULD still work
  on current Safari/Firefox.
- **Rule:** if a feature is **decorative**, use it freely (graceful degradation is fine). If it is
  **load-bearing for layout or usability**, wrap it in `@supports` with a fallback. Never let a
  cacher hit a broken log flow because a CSS feature was missing.

---

## HOW — canonical patterns (copy these)

**Container-query sheet/panel** (the core responsive primitive):
```css
.panel { container-type: inline-size; }
@container (min-width: 30rem) {
  .panel__body { grid-template-columns: 1fr 1fr; }
}
```

**Trust-tier / status tokens** (derive, don't hand-maintain):
```css
@layer tokens {
  :root {
    color-scheme: dark light;
    --accent:  oklch(0.72 0.13 200);          /* our own accent — NOT APRStac teal */
    --tier-a:  oklch(0.70 0.15 145);          /* RF-corroborated  */
    --tier-b:  oklch(0.78 0.13 250);          /* app-corroborated */
    --tier-c:  oklch(0.72 0.04 250);          /* IS-only / unverified */
    --ok:  oklch(0.72 0.17 145);
    --warn:oklch(0.80 0.16 85);
    --bad: oklch(0.63 0.20 27);
    --surface: light-dark(oklch(0.98 0 0), oklch(0.18 0.01 250));
  }
  .badge-a { background: color-mix(in oklch, var(--tier-a) 18%, transparent); color: var(--tier-a); }
  .badge:hover { background: color-mix(in oklch, currentColor 14%, transparent); }
}
```

**Conditional styling without JS:**
```css
.card:has(.badge-a) { outline: 1px solid var(--tier-a); }   /* highlight verified finds */
.row:has(:focus-visible) { background: color-mix(in oklch, var(--accent) 10%, transparent); }
```

**Mobile sheet that clears chrome + notch, snaps, respects motion:**
```css
.sheet {
  height: 100dvh;
  padding-bottom: env(safe-area-inset-bottom);
  scroll-snap-align: start;
  transition: transform .2s ease;
}
@media (prefers-reduced-motion: reduce) { .sheet { transition: none; } }
```

**Guard a load-bearing modern feature:**
```css
@supports (anchor-name: --x) { /* anchor-positioned popover */ }
@supports not (anchor-name: --x) { /* simple fallback position */ }
```

---

## Pre-commit checklist (Claude Code MUST self-check)

- [ ] Did I solve responsive sizing with **container queries**, not JS measurement?
- [ ] Are colors/tints **derived from tokens** (`color-mix`/OKLCH), not hard-coded or JS-computed?
- [ ] Is every interactive thing a **real semantic element** with focus states — not a CSS hack?
- [ ] Do animations use **only `transform`/`opacity`**, with a **reduced-motion** path?
- [ ] No `backdrop-filter`/large blur stacked over the map beyond one small surface?
- [ ] Mobile sizing uses **`dvh` + safe-area**; the tab bar/sheets clear the browser chrome?
- [ ] Any load-bearing modern feature is **`@supports`-guarded** with a fallback?
- [ ] I did **not** add a JS listener/library for something CSS already does declaratively?
