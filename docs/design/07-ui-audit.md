# UI Audit & Changes (against `.claude/rules/`)

Rules now live in the repo and are @-imported from `CLAUDE.md`:
**`.claude/rules/ui-ux.md`** (design principles) + **`.claude/rules/css.md`** (CSS-over-JS, tokens).

**Important correction to the original audit.** An earlier draft of this audit described `apps/web`
as "the M0 placeholder — inline styles, system-ui, no shell, no tokens, a static list." That was
written against the original scaffold; **it does not describe this branch.** As of M7 the app is a
full, tokenised, dark/light, mobile-first shell. So the audit's P0 ("establish tokens/shell/replace
the placeholder") was **already done here** — this document re-audits the *actual* code.

## Already compliant (M1–M7)
- **Tokens + theming** — OKLCH design tokens in `@layer tokens` with a `[data-theme]`
  dark(default)/light system + `color-scheme`; tier/status tints derived via `color-mix()`; no JS
  theme recomputation. (css.md token rule ✓.)
- **App shell** — persistent map + right-drawer (desktop) / bottom tab bar + bottom sheets (mobile,
  `@media`), context-aware FAB. Progressive disclosure: the workbench/BBS live behind Profile.
- **One primary action** — the one-tap `Log a find` state machine; DNF/note recede.
- **Trust badges** A/B/C; **mono** for callsigns/codes/coords; found-cache check on pins.
- **Field tolerance** — offline log queue with auto-sync; safe-area on the tab bar.

## Re-audit: real remaining gaps & status
| # | Gap vs rule | Status |
|---|---|---|
| §2 | **Settings/Workbench were flat lists** (no master toggle / collapse / status / search / reason) | **Fixed** — `ui.tsx` (`Group`/`Switch`/`Row`/`Advanced`) applied to Workbench (toggle-gated, collapsible, status at headers, reason-when-off) and Settings (grouped + search + Advanced). |
| §3 | on/off used `<input type=checkbox>` | **Fixed** — accessible `Switch` (`role=switch`), checkboxes removed; Filters keep checkboxes correctly (multi-select). |
| §3 | no shared primitives | **Done** — `apps/web/src/ui/`: `Switch`, `Group`/`Row`/`Advanced`, `Panel` (the docked-drawer/sheet surface every overlay uses), `Button`, `Badge`/`TierBadge`, `Card`, `EmptyState`, `Toast` (provider + `useToast`). All real semantic elements; appearance token-driven. |
| css.md | **container queries** (we use `@media`) | **Done** — `.panel` is a named query container (`container: panel / inline-size`); the workbench decoder goes two-column via `@container panel (min-width: 30rem)`. The panel↔sheet swap stays a `@media` query (viewport-coarse, per the css.md decision table). |
| css.md | **OKLCH tokens** (we used hex) | **Done** — tokens moved into `@layer tokens`, all values converted to OKLCH, `color-scheme` set per theme. We **keep the explicit `[data-theme]` layer** (css.md permits this) instead of `light-dark()` alone, because the app exposes a user-overridable Dark/Light/Auto switch that `light-dark()` can't honor. |
| css.md | derive **tier/status palette** via `color-mix()` | **Done** — `--tier-a/b/c`, `--ok/--warn/--bad` OKLCH bases; badges/`.error`/`.warn`/`button.danger` derive tints via `color-mix(in oklch, …)`. One derivation per state works in both themes, so the per-theme badge hex overrides were dropped. |
| css.md | **inline `style={{}}`** in App.tsx | **Done** — purged to token-driven utility classes (`.mt-*`, `.flex-1`, `.row.wrap`, `.clickable`, `.log-primary`, `.chip-btn`, …) backed by an `--sp-*` scale. The only inline styles left are the three data-driven cache-type glyph colours (`background: meta.color`), which are data, not tokens. |
| css.md | `dvh`/`svh` on sheets (we used `vh`/`%`) | **Done** — mobile sheet uses `max-height: 74dvh` (with `vh` fallback) and clears the tab bar + notch via `calc(60px + env(safe-area-inset-bottom))`; `viewport-fit=cover` added to `index.html`. |
| §3 | no `ui/` folder (everything in `App.tsx`) | **Done** — `App.tsx` (was ~1260 lines) is now a ~430-line shell (map orchestration + `TopBar`/`TabBar`); every panel lives under a feature folder: `caches/`, `log/`, `live/`, `identity/`, `activity/`, `profile/`, `workbench/`, `map/`, `ui/`. |

## Status
The css.md migration, the primitive set, and the feature-folder refactor are all **done** (see the
table above). `apps/web/src` is now: a slim `App.tsx` shell + `ui/` primitives + per-feature folders
(`caches/ log/ live/ identity/ activity/ profile/ workbench/ map/`). Panels compose from `Panel` and
the shared primitives; the OKLCH token layer + `color-mix()` palette + `@container`/`dvh` rules back
the styling.

Open follow-ups (tracked in `TODO.md`, not UI-audit gaps): passkey/WebAuthn sign-in, PMTiles basemap
+ service worker, and the deeper workbench protocols.
