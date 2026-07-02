# Rule: UI/UX Design Principles

**Scope.** This is the design-principles spec for everything in `apps/web` — the cacher app, the
workbench, and all maintenance/settings surfaces. Claude Code MUST consult this rule **before
building or changing any component or page**, and MUST keep components consistent with it. Styling
implementation is governed by the companion rule **`.claude/rules/css.md`** (CSS-over-JS, tokens,
performance) — the two are read together.

Keywords: **MUST / MUST NOT / SHOULD / SHOULD NOT / MAY** (RFC 2119).

---

## 0. North star — power without overwhelm

aprscaching is feature-rich (caching + a full APRS workbench), but **a user MUST be able to
operate any surface without being overwhelmed.** Capability is revealed progressively; the default
view is simple; depth is one clear step away. Two density contexts coexist:

- **Cacher surface** — comfortable, glanceable, one obvious action per screen.
- **Workbench / maintenance** — denser and more powerful, but still **grouped, toggled, and
  collapsible** so an operator is never handed a wall of controls.

If a screen feels like "a big list of everything," it is wrong. Fix it with the patterns below.

---

## 1. Core principles (MUST hold across the app)

1. **Progressive disclosure.** Show the minimum needed now; reveal advanced/rare options on demand.
   The cacher never sees workbench machinery; the operator never sees every knob at once.
2. **Group, never dump.** Related controls MUST be organized into labelled sections/cards with
   clear hierarchy. A flat list of more than ~5–7 sibling controls is a defect.
3. **Toggle-gated groups.** Any optional subsystem (a transport port, IGate, digipeater, announce,
   a notification category) MUST be a group with a **master switch**. When the switch is **off**,
   the group's detail controls MUST **collapse and/or disable (greyed)** — not clutter the screen.
   When a group is unavailable, show a one-line reason instead of dead controls.
4. **One primary action per screen.** Visual hierarchy MUST make the primary action unmistakable
   (e.g. *Log find*). Secondary/tertiary actions recede.
5. **Sensible defaults.** Every setting MUST ship a good default. Expert settings live under an
   **Advanced** disclosure, collapsed by default.
6. **Consistency over cleverness.** The same pattern MUST use the same component everywhere
   (one switch, one slider, one sheet, one badge). No bespoke one-offs when a primitive exists.
7. **Always feedback.** Every action MUST give immediate feedback (state change, toast, inline
   result). No silent successes or failures.
8. **Forgiving.** Destructive actions MUST confirm; provide undo where feasible; validation is
   inline and non-blocking, never a wall between the user and their goal.
9. **Glanceable & legible.** Field use: large tap targets (≥44px), high contrast, scannable
   structure, mono for callsigns/coords.
10. **Accessible by default.** Real semantics, visible focus, keyboard operability, ARIA where
    needed, reduced-motion honored. Accessibility is not optional polish.

---

## 2. Settings & dense-config architecture (the anti-"big fat list" rule)

This applies to **app settings, account/profile, connections/network config, an individual workbench
app's surface, and any maintenance page.** (The Workbench itself is an app launcher, not a config
page — see §5.)

**Structure MUST be:** Page → **grouped sections (cards)** → each group has a **header with a
master toggle/status** → child controls. Specifically:

- A page MUST be split into labelled groups; a group MUST NOT exceed ~7 controls before being
  sub-grouped or given an Advanced disclosure.
- Each **toggleable subsystem MUST be a group with a master switch.** Off ⇒ children
  **collapse/disable**. On ⇒ children reveal.
- Each group MAY be **collapsible** (disclosure) independent of its on/off state, so the page stays
  short; remember expanded/collapsed state.
- Provide **search/filter** on any settings page with more than ~3 groups.
- Each setting MUST have: a clear label, optional one-line help, a sensible default, and the right
  control (see §3). Risky/expert ones go under **Advanced**.
- Show **status at the group header** (e.g. `active`, `inactive`, `needs verification`) so the
  operator scans state without expanding.

```
┌ Settings        [ ⌕ search settings… ]                      ┐
│                                                              │
│  ▣ Notifications                                  [ ●—— ]    │ group master = ON
│      Geofence prompts                             [ ●—— ]    │
│      Find confirmations                           [ ——○ ]    │
│      ▸ Advanced (sound, throttling)                          │ collapsed
│                                                              │
│  ▢ APRS-IS announce                               [ ——○ ]    │ master OFF → children hidden
│      Verify your callsign to enable announce.               │ reason, not dead controls
│                                                              │
│  ▣ Ports & transports                             [ ●—— ]    │
│      ▸ APRS-IS                     active          [ ●—— ]    │ collapsed; expand to configure
│      ▸ KISS TCP                    inactive        [ ——○ ]    │
│      ▸ Meshtastic                  inactive        [ ——○ ]    │
└──────────────────────────────────────────────────────────────┘
```

**MUST NOT:** render a long flat list of unrelated toggles; leave a disabled subsystem's controls
visible-but-dead with no explanation; bury the on/off control where the user can't find what a
group does.

---

## 3. Component inventory & when to use which (MUST reuse these)

**Controls**
- **Switch / toggle** — turn a function or group on/off (binary, immediate effect). The default for
  enabling/disabling subsystems.
- **Segmented control** — pick one of 2–4 mutually exclusive modes (e.g. map layers, "All finds /
  Verified only").
- **Slider** — a continuous/ranged value (radius, time window, opacity). Pair with a numeric
  readout.
- **Select / combobox** — one of many options; combobox when searchable (callsign, region).
- **Stepper / number** — small bounded integers.
- **Checkbox** — multi-select within a set (filters). (Use a switch, not a checkbox, for
  on/off-a-feature.)

**Containers**
- **Card** — a grouped block of related content/controls (settings group, cache summary).
- **Bottom sheet** — mobile contextual detail/actions over the map (cache detail, log). Default on
  mobile.
- **Drawer / side panel** — desktop equivalent docked beside the map.
- **Dialog (modal)** — a focused decision/confirm; MUST trap focus and be dismissible. Use
  sparingly.
- **Popover** — lightweight contextual menu/tooltip anchored to a control.
- **Disclosure / accordion** — collapse secondary content (Advanced, group sections). MUST be a
  real `<button>`-driven disclosure, never a CSS-only `:target` hack (see css.md).

**Navigation**
- **Bottom tab bar** (mobile) / **left rail** (desktop) for top-level destinations.
- **Breadcrumb** inside the deeper workbench only.

**Data display**
- **List row** — scannable items (Nearby caches, logbook, station list). Consistent row anatomy.
- **Table** — workbench tabular data (stats, port RX/TX) only; not for the cacher surface.
- **Badge / chip** — compact status/trust (`Tier A/B/C`, `RF`/`IS`, status colors). One shared
  component, color from tokens.
- **Stat** — a single highlighted metric (finds, 24h RX).

**Feedback**
- **Toast** — transient confirmation (announced ✓, logged ✓) and the **geofence prompt**.
- **Inline alert** — contextual warning/error tied to a control.
- **Skeleton / spinner** — loading; progressive (don't block the whole screen — see css.md).
- **Empty state** — every list/collection MUST define one with a helpful next action.

---

## 4. Required states (every interactive component MUST define all)

`default · hover · focus-visible · active · disabled · loading · empty · error · success`.
A component PR is incomplete if any applicable state is missing. Disabled controls MUST explain
*why* when the reason is non-obvious (e.g. "verify callsign to enable").

---

## 5. Page templates (compose from the inventory)

- **Cacher map (home):** full map + floating overlays + bottom sheets + tab bar. One primary action.
- **Cache detail:** bottom sheet; single primary *Log find*; secondary actions recede.
- **Hide-a-cache / forms:** **sectioned** (grouped) form, inline validation, optional fields marked,
  never one long scroll of inputs.
- **Settings / profile / maintenance:** §2 architecture — grouped, toggle-gated, collapsible,
  searchable. This is the home for **per-user config** — the user's own account/profile, their browser
  RF bridge (My radio), locale/units, notifications (incl. the watchlist), and GDPR data tools.
  **MUST NOT** surface instance-wide config here (see the operator surface below).
- **Instance admin (operator/sysop surface):** instance-WIDE configuration — the federation network
  (peers + trust), FBB forwarding (partners + routing rules), and the server ingest data plane
  (transports, TAK/CoT feed) — belongs to the ham who **deployed** this instance, NOT to platform
  users. It MUST live on a **dedicated, sysop-gated surface** (revealed only when the signed-in account
  is an operator, `ADMIN_CALLSIGNS`), and every write MUST be gated **server-side** (`requireSysop`),
  never merely hidden in the UI. A normal user MUST NOT see or reach it.
- **Workbench:** an **app launcher**, not a config page. It lists the operator *apps* (packet
  terminal, BBS, packet decoder, NET/ROM node, tools/plugins, rig control, remote box); each launches
  into **its own surface** and can be **pinned to the nav rail**. Anything that is APRS/APRScaching
  *functionality* lives OUTSIDE the workbench — on the map (caches, live stations, spots), as its own
  surface (Messages), or in Settings (the config above). Each launched app surface is itself denser,
  grouped by subsystem, with status at headers per §2.

---

## 6. Density & consistency

- **Two density modes:** comfortable (cacher) and compact (workbench). MUST be a token-level switch
  (spacing/type scale), not per-component guesswork.
- **Design tokens are the single source of truth** for color, spacing, type, radius, elevation —
  defined and used per `.claude/rules/css.md`. MUST NOT hard-code values or use inline styles for
  tokenable properties.
- **Our own visual identity:** our accent (not APRStac's teal), our cache-type glyph set, our type.
  Borrow patterns from APRStac, not the skin (see `docs/design/06-ui-ia-m1.md` §15).

---

## 7. Accessibility (MUST)

- Real semantic elements (`button`, `a`, `nav`, `ul`, `dialog`); never styled-div substitutes.
- Visible `:focus-visible`; full keyboard operability; logical focus order; focus-trap in dialogs.
- Hit targets ≥44px; contrast meets WCAG AA (verify in dark *and* sunlight/light mode).
- Label every control; associate help/error text; use ARIA only to fill genuine gaps.
- Honor `prefers-reduced-motion`; never convey state by color alone (pair with icon/text).

---

## 8. Microcopy

Labels are short, concrete, action-oriented. Help text is one line. Errors say what happened and
how to fix it. Uppercase only for small section labels/badges, not body. Callsigns/coords in mono.

---

## 9. Definition of Done

**A component is done when:** it reuses tokens (no inline styles); defines all applicable §4 states;
is keyboard- and screen-reader-operable with visible focus; works in dark + light; honors
reduced-motion; is responsive via container queries (css.md); and matches an existing pattern
rather than inventing one.

**A page is done when:** it has one clear primary action; content is grouped (no flat dumps);
optional subsystems are toggle-gated and collapsible; long forms/settings are sectioned and
searchable; empty/loading/error states exist; and it reads cleanly at arm's length on a phone.

> Before writing styles for any of the above, follow `.claude/rules/css.md` (CSS-over-JS, tokens,
> performance budget over the map).
