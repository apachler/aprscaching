# Cogmind "Terminal" Theme — Feature Plan

**Project:** aprscaching.com (greenfield revival)
**Doc type:** Implementation plan (Claude Code foundation)
**Status:** PLANNED — not yet built. One of **exactly two dark-only themes** (Modern + Cogmind); the
roadmap (`docs/26` Stage 3) merges this with the retro terminal shell — **selecting Cogmind *is* the
late-90s flip**. Light mode is dropped from scope.
**Owner:** OE8APR
**Reads with:** `.claude/rules/ui-ux.md`, `.claude/rules/css.md`, `docs/06-ui-ia-m1.md`, `docs/27`
(Graphic Packet heritage).

---

## 1a. Locked design decisions (2026-06 — from Graphic Packet / F6FBB heritage research)

Research into the actual packet-era look (GP was a *graphics-mode* DOS app with bordered multi-channel
windows + color-by-station-type via `NAMES.GP`; F6FBB/BPQ BBS menus were 16-color ANSI, not monochrome)
settled these, locked by the owner:

1. **Palette = hybrid.** A green-phosphor **base** + a disciplined **DOS-derived accent set**
   (cyan/amber/red/white) used **only where color carries meaning** — trust tiers A/B/C, station types
   (the `NAMES.GP` registry), TX/RX. NOT pure monochrome (less faithful to GP/FBB) and NOT a busy full
   16-color field. Accents derived in OKLCH for even brightness (`css.md`).
2. **Coverage = context-aware, but total.** **Every** element follows the Cogmind theming — header,
   nav rail/menu, all controls, sheets, the map — nothing un-themed. Packet/BBS/terminal/workbench
   surfaces additionally lean into the **full ANSI-BBS treatment** (box-drawing channel windows, ANSI
   menus); map/cacher surfaces get the lighter HUD skin. The flip is strongest where the heritage lives,
   but the chrome is coherent everywhere.
3. **CRT FX = off by default, opt-in.** No scanlines/glow/flicker unless the user enables it; the retro
   feel comes from layout + palette + font. (Still `prefers-reduced-motion`-gated when on.) Best for the
   outdoor/field GPU budget.
4. **Font = a bundled CP437/VGA bitmap-style webfont** (PxPlus / More-Perfect-DOS-VGA lineage, OFL/free),
   loaded **only** when the Cogmind theme is active (lazy, ~30–80 KB) — authentic DOS glyphs + box-
   drawing. Modern theme keeps IBM Plex Mono.

These shape how the **P1 packet terminal** (Stage 1) is built: its channel windows, monitor, status
line, `NAMES.GP` coloring and ANSI subset are authored **token-driven**, so the Stage-3 flip is a token
swap, not a rebuild.

---

## 1. Purpose

Add an **opt-in, full-application visual theme** inspired by **Cogmind** (Grid Sage Games) — a
sci-fi roguelike defined by its CP437/ASCII terminal aesthetic: dark phosphor palette, monospace
glyph art, box-drawing borders, an "all information visible at once" HUD, and restrained ASCII
motion.

The earlier scoping limited this to the workbench. **This plan supersedes that: when the theme is
active, the *entire* app — landing, cacher map, sheets, forms, settings, profile, BBS, activity,
*and the MapLibre map itself* — must be coherently styled.** A half-themed app (terminal chrome over
a Google-ish map) breaks the illusion and looks broken, so the map is in scope, not excluded.

It is a **theme, not a rewrite**: same components, same routes, same accessibility contract —
re-skinned through the token layer the CSS policy already mandates.

---

## 2. Non-negotiable constraints (from our own rules)

The theme MUST NOT regress the field-use mission. These hold even in Cogmind mode:

- **Opt-in + reversible.** Default theme stays `dark`/`light`/`auto`. Cogmind is a fourth choice in
  Settings → Display (the existing theme segmented control). One tap back out, persisted.
- **WCAG AA contrast** in every view (verify in sunlight). Phosphor-on-black is easy to get wrong;
  derive the palette in OKLCH so brightness stays even across hues (`css.md`).
- **`prefers-reduced-motion` honored.** Scanlines, glow pulses, the boot sequence, and any "type-on"
  text MUST have a reduced/zero-motion path. None of it is load-bearing.
- **Touch targets ≥44px, mobile-first layout unchanged.** We restyle, we do not re-lay-out the
  cacher surface into an 80×60 desktop grid. Density stays driven by the existing comfortable/compact
  token switch.
- **No heavy effects stacked over the map.** `css.md` forbids full-screen `backdrop-filter`/blur over
  MapLibre. A scanline/vignette overlay MUST be a single cheap, compositor-friendly layer (or off on
  the map). The map is restyled at the *style-JSON* level, not by painting ASCII over the GPU canvas.
- **Real semantics survive.** No CSS-only ASCII hacks that break keyboard/AT. Box-drawing borders are
  decorative `::before`/background, never structural.

> The litmus test: a cacher in bright sun, one-handed, with reduced-motion on, can still log a find
> in Cogmind mode without strain. If not, the theme is wrong.

---

## 3. Design language — translating Cogmind to aprscaching

| Cogmind trait | Our translation |
|---|---|
| CP437 dark phosphor palette, hue-shifting | A `[data-theme="cogmind"]` OKLCH token set: near-black bg, phosphor-green primary, amber/cyan accents, trust tiers re-hued onto the phosphor ramp (A=green, B=cyan, C=dim). |
| Monospace bitmap fonts | A mono UI font stack for *all* text in-theme (`ui-monospace, "IBM Plex Mono", "Berkeley Mono", monospace`); callsigns/coords already mono. |
| ASCII box-drawing borders (`┌─┐│└┘`) | Panels/cards/sheets get a box-drawing frame via tokens (border + corner glyphs as `::before/::after` or a border-image), not new DOM. |
| "Everything visible at once" HUD | Reinforces our workbench; on the cacher surface we keep progressive disclosure (mission > mimicry). The HUD ideal lands fully in the **TUI monitor** (§6). |
| ASCII particle/scanline motion | One optional scanline + faint vignette overlay (reduced-motion-aware, toggleable); subtle CRT flicker off by default. |
| REXPaint glyph art | Reuse our existing glyph sets (cache types, station roles, APRS categories) but swap to a "boxed glyph" rendering; optional CP437-flavored variants later. |
| Boot/title sequence | A short, skippable "boot log" splash on first load in-theme (honors reduced-motion → instant). |

Accent identity stays **ours**, not Cogmind's exact green — we pick a phosphor that passes AA on our
black and reads as *aprscaching-in-terminal-mode*, not a clone.

---

## 4. Architecture

### 4.1 Token layer (the spine)
Everything keys off one switch. Per `css.md`, theming is token-driven via a `[data-theme]` layer —
no JS color math, no per-component branching.

- Add `[data-theme="cogmind"]` to `ui/tokens.css` overriding the full token set: surfaces, ink,
  lines, accent, trust tiers (`--tier-a/b/c`), status colors, radii (→ near-0, terminals are sharp),
  elevation (→ flat + glow instead of shadow), font family, and a few theme-only tokens
  (`--crt-scanline`, `--glow`, `--frame-glyph`).
- `App` sets `document.documentElement.dataset.theme = settings.theme`. Already wired for
  dark/light/auto; add `cogmind` as a value. **Every existing component inherits the new look with
  zero per-component edits** — that's the payoff of having stayed token-driven.

### 4.2 Map style swap (the hard part)
The map is a MapLibre GL vector canvas; it can't inherit CSS tokens. So the theme owns a **dedicated
map style**:

- Add `buildCogmindStyle()` beside the existing `buildGraticuleStyle()` (`apps/web/src/map/`): a
  self-contained MapLibre style JSON — near-black background, dim phosphor graticule/grid, monochrome
  land/water, glowing thin road/coastline lines, terminal-green labels in the mono font. Built on the
  same offline-capable primitives so it works keyless and offline (field use).
- On theme change, call `map.setStyle(cogmindStyle)` and **re-add our sources/layers + DOM markers**
  in the `style.load` handler (markers are React-managed `maplibregl.Marker`s, so re-attach on style
  swap). Persist the choice so reload picks the right style up front (avoid a flash).
- **Markers** (cache/station/spot pins) get a Cogmind variant via the token layer (they're DOM):
  boxed glyphs, phosphor fill, glow ring. Glyph precedence (cache → role → APRS → dot) is unchanged.
- Raster/satellite layers stay opt-in and are visually out-of-theme by nature — acceptable; a
  one-line note ("raster basemap is unstyled") suffices, matching the existing opt-in-raster rule.

### 4.3 Component reskins
Most components need nothing. A handful get theme-aware flourishes behind the token/`:where([data-theme="cogmind"])`
selector: `Panel`/`Group`/`Card` (box-drawing frame + header rule), `Badge`/`TierChip` (bracketed
`[A]`/`[RF]` style), `Button` (terminal `> action` affordance), `LoadMore` (`-- more --`), empty/loading
states (blinking cursor, ASCII spinner). All reduced-motion-aware.

---

## 5. Accessibility & performance plan

- **Contrast:** author the phosphor ramp in OKLCH; unit-check AA for text/bg and each tier badge in
  both the densest (workbench) and brightest (sunlight/cacher) contexts.
- **Motion:** a single `@media (prefers-reduced-motion: reduce)` block neutralizes scanlines, glow
  pulse, boot type-on, and CRT flicker. Theme remains fully usable static.
- **Performance:** scanline = one fixed `repeating-linear-gradient` layer with `pointer-events:none`,
  `will-change` avoided; **disabled over the map** (map gets its phosphor look from the style JSON,
  not an overlay). No blur. Boot splash is a one-shot, GPU-cheap `opacity` fade.
- **Map cost:** the Cogmind style keeps layer count ≤ the graticule style; labels and glows are thin
  vector lines, not raster — no extra tile bandwidth.
- **Escape hatch:** any contrast/legibility complaint is one tap to `auto`. The default is never
  Cogmind.

---

## 6. View-by-view coverage (definition of "fully styled")

Each MUST read correctly in-theme:

1. **Landing / onboarding** (`Landing.tsx`, `ui/Tour.tsx`) — boot-log title, terminal CTAs; tour
   steps inherit panel framing.
2. **Cacher map (home)** — Cogmind map style + boxed markers + terminal tab bar/overlays; one primary
   action still obvious.
3. **Cache detail sheet** — framed bottom sheet; `Log find` as the primary terminal action.
4. **Log flow** — inputs as terminal fields; result card as a boot-style readout (tier in brackets).
5. **Nearby / Activity / Leaderboard / BBS** — list rows as monospace tabular lines; `LoadMore` as
   `-- more --`.
6. **Settings / Profile / My stations** — grouped panels with box frames; toggles as `[x]/[ ]`.
7. **Workbench** — the natural home; packet inspector, ports RX/TX bars, station registry, federation
   all lean into the HUD look.
8. **TUI monitor (new, optional within this feature)** — a full-screen `<pre>`-grid live HUD (packets,
   stations, port bars, message log) — the purest Cogmind expression, fed by data we already serve.

---

## 7. Phasing

- **T1 — Tokens + chrome (small).** `[data-theme="cogmind"]` token set, font, box-frame primitives,
  badge/button/list reskins, boot splash, Settings toggle. Whole app shifts; map still default style.
- **T2 — Map style (medium).** `buildCogmindStyle()` + `setStyle` swap + marker re-attach + boxed
  marker variants + persistence. This is what makes it "fully styled."
- **T3 — HUD + flourishes (medium/large).** TUI monitor panel; scanline/CRT toggle; CP437 glyph
  variants; ANSI export of the packet log; optional standalone `aprscaching-tui` read-API client
  (pairs with the Bun single-binary desktop topology).

Ship T1 first (high impact, low risk), then T2 (closes the "map looks wrong" gap), then T3 as polish.

---

## 8. Risks & open questions

- **Contrast drift** across 8+ surfaces — mitigated by OKLCH-derived ramp + an AA check matrix.
- **`setStyle` marker loss** — must re-add all sources/layers/markers on `style.load`; cover with a
  manual check (toggle theme with stations + caches + spots on, confirm all re-render).
- **Mono font weight/availability** — bundle a licensed mono or use the system `ui-monospace` stack to
  avoid a web-font fetch on the field path.
- **Scope creep into a re-layout** — explicitly out: we restyle, we do not rebuild the cacher into a
  desktop terminal grid. The 80×60 HUD ideal is confined to the workbench + TUI monitor.
- **Theme persistence vs SSR/first paint** — read the saved theme before first map init to avoid a
  style flash.

---

## 9. Definition of Done

- Settings → Display offers **Cogmind**; choice persists; default unchanged.
- Every view in §6 reads coherently in-theme, including the **MapLibre map** (Cogmind style) and its
  markers.
- AA contrast holds across all surfaces in dark+bright; `prefers-reduced-motion` fully neutralizes
  motion; touch targets and the log flow are uncompromised.
- No blur/heavy effect over the map; map style ≤ graticule layer budget; no web-font on the field
  path (or one small bundled mono).
- Toggling the theme live re-renders the map + all markers with no lost layers.
- One tap returns to `auto`. Nothing in the cacher flow is gated behind the theme.

---

## Appendix — Cogmind reference

Grid Sage Games dev blog (aesthetic, mockups, fonts, color): genre innovation, the "Full UI
Upscaling" series (REXPaint mockups), font creation, and color-customization (hue-shifting) posts.
Signature traits to borrow: CP437 glyph art, dark phosphor palette, box-drawing frames, all-info HUD,
restrained ASCII motion — borrow the *language*, keep our own accent and our mission constraints.
