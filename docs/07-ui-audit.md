# UI Audit & Changes (against `.claude/rules/`)

Rules now live in the repo and are @-imported from `CLAUDE.md`:
**`.claude/rules/ui-ux.md`** (design principles) + **`.claude/rules/css.md`** (CSS-over-JS, tokens).

**Important correction to the original audit.** An earlier draft of this audit described `apps/web`
as "the M0 placeholder — inline styles, system-ui, no shell, no tokens, a static list." That was
written against the original scaffold; **it does not describe this branch.** As of M7 the app is a
full, tokenised, dark/light, mobile-first shell. So the audit's P0 ("establish tokens/shell/replace
the placeholder") was **already done here** — this document re-audits the *actual* code.

## Already compliant (M1–M7)
- **Tokens + theming** — `:root` design tokens with a `[data-theme]` dark(default)/light system; no
  JS theme recomputation. (css.md token rule ✓; OKLCH/`light-dark()` migration still pending.)
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
| §3 | no shared primitives | **Partial** — `Switch/Group/Row/Advanced/Segmented` extracted; Button/Card/Sheet/Badge still raw element+class. |
| css.md | **container queries** (we use `@media`) | **Pending** — migrate panel/sheet responsiveness to `@container`. |
| css.md | **OKLCH + `light-dark()` tokens** (we use hex + `[data-theme]`) | **Pending** — token migration to `@layer tokens` per css.md. |
| css.md | **44 inline `style={{}}`** in App.tsx | **Pending** — move tokenable values to classes. |
| css.md | `dvh`/`svh` on sheets (we use `vh`/`%`) | **Pending**. |
| §3 | no `ui/` folder (everything in `App.tsx`) | **Deferred** — feature-folder refactor as an isolated pass. |

## Next pass (CSS-rule compliance + primitives)
1. **css.md migration** — `ui/tokens.css` with `@layer tokens`, OKLCH + `light-dark()`, derive
   tier/status via `color-mix()`; switch component responsiveness to `@container`; `dvh`+safe-area on
   sheets; purge inline styles.
2. **Finish primitives** — Button, Card, Sheet, Badge/TierBadge, ListRow, EmptyState, Toast; reuse
   everywhere (Definition-of-Done §9).
3. **Folder refactor** — `App.tsx` → `map/ caches/ log/ live/ identity/ activity/ profile/ workbench/ ui/`.
