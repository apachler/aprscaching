# Design language

How APRScaching looks, reads and behaves, as one set of decisions that every surface follows. It is for people
who build or review the web app; the operator and player guides never need it. The tokens live in
`apps/web/src/styles/tokens.css`, and `/?demo=ui` (the UI kit) shows every one of them live, in each theme,
beside the primitives that use them. Where the app does not meet this page yet, the design review
(`docs/reviews/design-review-2026-10.md`) lists it.

## Principles

1. **Field first.** People use the app outdoors, on a phone, often with one hand and in sunlight. Large targets,
   high contrast, short words.
2. **Power without overwhelm.** The default view is simple; depth is one clear step away (`ui-ux.md` §0).
3. **One way to do a thing.** One component per pattern, one token per role, one icon set.
4. **Honest.** Real data or nothing: a skeleton while loading, a clear empty state, never invented numbers.
5. **Calm.** Colour and motion carry meaning, never decoration. The map is the hero; the chrome stays out of its
   way.

## Themes

| Theme | What it is | Who picks it |
|---|---|---|
| **Dark** | The default for everyone: a dark blue-grey chrome around the map. | Default; Settings → Display → Appearance |
| **Light** | The same palette on white, for bright sunlight and people who prefer it. | Appearance |
| **Auto** | Dark or light, following the system, and switching live when it changes. | Appearance |
| **Phosphor** | A late-90s green-phosphor terminal: mono type, sharp corners, a glow instead of shadows, CP437 glyphs. | Appearance |

A theme is a token set on the root (`data-theme`), never a per-component rebuild. Phosphor stays itself: it
keeps its own palette, type and shapes, and the role scales below apply to it with sharp corners and glow.

## Colour

Colours are OKLCH, so brightness stays even across hues. A tint is derived with `color-mix()` at the point of use,
never kept as a second hand-made colour. Every colour has one role:

| Role | Token | Used for |
|---|---|---|
| Page | `--page-bg` | Behind the map and full pages |
| Surface | `--surface`, `--surface-2`, `--panel-2`, `--field-bg` | Panels and sheets; raised controls; operator side panels; inputs |
| Text | `--ink`, `--ink-2`, `--muted`, `--heading` | Running text; bright data values; secondary text; headings and links |
| Lines | `--line`, `--hair` | Borders of controls; hairline dividers |
| Brand | `--brand`, `--topbar-bg`, `--rail-bg`, `--chrome-ink` | The chrome: top bar, rail, and text on them |
| Action | `--accent` (fill), `--accent-text` (text, links, icons), `--accent-ink` (text on the fill) | The one primary action per screen |
| Chrome text | `--chrome-ink-muted`, `--chrome-field-bg`, `--chrome-hover-bg` | Secondary text on the chrome; fields and chips in the top bar; their hover |
| Selection | `--selected-bg` | The selected rail item, segment or chip, under `--heading` text |
| Trust | `--tier-a`, `--tier-b`, `--tier-c` (fills); `--tier-a-text`, `--tier-b-text`, `--tier-c-text` | Tier A Radio-verified, Tier B Location-verified, Tier C Logged |
| Status | `--ok`, `--warn`, `--bad` (fills); `--ok-text`, `--warn-text`, `--bad-text` | Success, warning, error and danger |
| Map controls | `--map-control-ink` | Glyphs on MapLibre's control stack, which is white in every theme |

**The accent has two roles.** The brand green fills the primary button, with dark ink on it. As text, a link or an
icon on a light surface, the same green is too light to read, so text uses `--accent-text`: a darker green in
the light theme and the same green in dark. A colour that plays two roles gets two tokens.

**Hues as text.** A tier or status colour used as text, an icon or a badge's lettering is its `-text` token: the
base mixed toward `--ink` by `--hue-text`. On a dark surface that lifts it, on a light one it deepens it, from one
formula; Phosphor keeps its own ramp. A per-item colour (a cache type) is mixed the same way where it is set.

**Contrast.** Every foreground/background pair a stylesheet uses meets WCAG 2.2 AA in every theme: 4.5:1 for
text, 3:1 for large text, icons, borders that identify a control, and focus indicators.
`apps/web/test/contrast.test.ts` measures the declared pairs in CI.

**Never colour alone.** A tier, a status or a state also has a word, a letter or an icon: the tier badge says
"Radio-verified", the chip says "A", a blocked locate button is struck through.

## Type

Three faces: **Fredoka** for the brand and titles, the **system UI** face for running text, **IBM Plex Mono** for
data (callsigns, coordinates, packets). Phosphor uses its VGA face for all three. Sizes follow a 1.2 ratio around a
14 px body and are named by role:

| Role | Token | Size | Face, weight | Line height |
|---|---|---|---|---|
| Display | `--text-display` | 34–56 px, fluid | Fredoka 700, tracking −0.01em | 1.15 |
| Page title | `--text-title-lg` | 24 px | Fredoka 700 | 1.15 |
| Panel title | `--text-title` | 20 px | Fredoka 700 | 1.15 |
| Heading | `--text-heading` | 17 px | Fredoka 600 | 1.3 |
| Input (touch) | `--text-input` | 16 px | UI 400 | 1.3 |
| Body | `--text-body` | 14 px | UI 400 | 1.5 |
| Data | `--text-data` | 13 px | Mono 400–600 | 1.3 |
| Label | `--text-label` | 12 px | UI 600, uppercase, tracking 0.04em | 1.3 |
| Caption | `--text-caption` | 11 px | UI 400 | 1.3 |
| Micro | `--text-micro` | 10 px | UI 500 | 1.3 |

Micro is only for the labels under rail and tab-bar icons. Uppercase is only for labels and badges, never for
running text. The compact density (Shack apps, instance admin) sets body to 13 px.

## Space

A 4 px rhythm, with 2 px only for optical nudges:

| Token | `--space-2xs` | `--space-xs` | `--space-sm` | `--space-md` | `--space-lg` | `--space-xl` | `--space-2xl` | `--space-3xl` | `--space-4xl` |
|---|---|---|---|---|---|---|---|---|---|
| px | 2 | 4 | 8 | 12 | 16 | 24 | 32 | 48 | 64 |

Spacing is picked by role, and the roles follow the density:

| Role | Token | Comfortable | Compact |
|---|---|---|---|
| Between an icon and its label, buttons in a row | `--gap-inline` | 8 | 8 |
| Between rows of a list or a form | `--gap-stack` | 12 | 8 |
| Inside a card | `--pad-card` | 16 | 12 |
| Inside a panel | `--pad-panel` | 16 | 12 |
| Between groups of a page | `--gap-section` | 24 | 16 |

## Shape and depth

| Radius role | Token | Modern | Phosphor |
|---|---|---|---|
| Marks: bars and meters | `--radius-tick` | 2 px | 0 |
| Chips, badges, tags | `--radius-chip` | 6 px | 0 |
| Controls: buttons, inputs, segments | `--radius-control` | 8 px | 0 |
| Cards, groups, list cards | `--radius-card` | 12 px | 1 px |
| Panels, sheets, dialogs | `--radius-sheet` | 16 px | 1 px |
| Pills | `--radius-pill` | round | 2 px |

| Elevation role | Token | Used for |
|---|---|---|
| Flat | `--elevation-flat` | Everything that sits in a panel |
| Raised | `--elevation-raised` | Map pins, a card that lifts off its panel |
| Floating | `--elevation-floating`, `--elevation-floating-up` | Panels and sheets over the map, toasts, map cards, the top bar; the tab bar casts upward |
| Overlay | `--elevation-overlay` | Dialogs, popovers, the tour |

Shadows use the theme's `--shadow` colour, which Phosphor turns into a green glow.

## Iconography

One icon set: **line icons** (`Icon`), 24 px grid, 2 px stroke, round caps, coloured by `currentColor`. They are
used everywhere in Modern, including the tab bar and panel titles. Phosphor draws the same places with CP437
glyphs, through the same component, so no surface chooses between two systems. Emoji are never UI: a test
(`apps/web/test/no-emoji.mjs`) keeps them out of rendered text. A button that shows only an icon has an accessible
name.

## Motion

Motion explains a change; it never decorates.

| Token | Duration | For |
|---|---|---|
| `--motion-fast` | 120 ms | Hover, press, toggles |
| `--motion-base` | 200 ms | Sheets, panels, disclosures |
| `--motion-slow` | 320 ms | The landing page's one entrance |

Easing is `--ease-standard` going in and `--ease-exit` going out. Only `transform` and `opacity` animate over the
map (`css.md`). When the system asks for reduced motion, every duration is zero. The landing page has a budget:
one entrance and the terminal card's short sequence, nothing on scroll.

## Imagery

Screenshots are real surfaces of the app with the demo fixtures, framed as a phone or a desktop, and large
enough to read. Photos are the operator's own, or licensed and credited. The map in imagery is the same basemap
in every theme.

## Words

- **Sentence case** for headings, buttons and labels: "Log a find", not "Log A Find".
- **Plain verbs** on buttons: Log a find, Navigate, Hide a cache, Sign in.
- **The glossary's names**, the same in the app, the landing page and the manual: Tier A **Radio-verified**,
  Tier B **Location-verified**, Tier C **Logged**; RF, IS (APRS-IS), IGate, the Shack, sysop.
- **An error says what happened and how to fix it**: "The logbook did not load. Try again."
- **Disabled controls say why** when it is not obvious: "Verify your callsign to enable transmit."
- Callsigns, coordinates and grid locators are in the data face.

## Accessibility commitments

- WCAG 2.2 AA in every theme, measured: the contrast test in CI and axe on the UI kit and the main surfaces.
- Real elements first (`button`, `a`, `dialog`, `nav`, lists), ARIA only to fill a gap.
- Every control works with a keyboard. Focus is always visible and never hidden behind a sheet or the top bar.
- Touch targets are at least 44 px, and never under 24 px with spacing.
- The map is never the only way to reach something: Nearby, search and the zoom buttons work without dragging.
- Help sits in the same place on every surface: the manual button in the top bar.
- Status messages (toasts, an incoming message) are announced politely.

## Next

- `/?demo=ui` in a running app: the tokens and primitives, live.
- [Testing & verification](../reference/testing.md): the contrast test, the UI kit and the visual harness.
