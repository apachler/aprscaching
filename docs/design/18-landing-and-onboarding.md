# Landing page & unauthenticated onboarding flow (mechanics)

Status: **Mechanics IMPLEMENTED (L2–L4); L1 deployment pending. Content deferred.** The marketing
**content** (landing copy, feature list, screenshots, the quick-tour step text/targets) is
**explicitly deferred**: the platform is in active development and writing copy now would churn. This
doc specs the *plumbing* — domains, the landing gate, the read-only entry, and the tour framework —
so the content can be dropped in later without rework. Build against `.claude/rules/{ui-ux,css}.md`.

> **Done (web, mechanics):** `apps/web/src/Landing.tsx` (brand-hero gate with Register/Login/Explore),
> the landing gate + per-session Explore intent + signed-out→read-only + sign-out-returns-to-landing
> in `App.tsx` (map init + live WebSocket now defer until the app is active), and `ui/Tour.tsx` (an
> accessible, reduced-motion, config-driven quick-tour with a remembered "seen" flag and one
> placeholder step). Verified by Playwright (landing desktop+mobile, Explore→read-only, tour card).
> **Pending:** L1 — the `.com`→`.net` edge 301 + `.net` `INSTANCE`/`APP_URL`/`RP_ID`/API-host config
> (deployment/DNS, not app code). **Deferred:** all landing copy + real tour steps.

## Deployment / domain (decided)
- **`aprscaching.net` is canonical** — it hosts the **first network peer** *and* the marketing
  landing + the platform.
- **`aprscaching.com` 301-redirects to `aprscaching.net`** at the edge, **before any app/auth code
  runs**.
- Configuration aligns to `.net`: `INSTANCE=aprscaching.net`, `APP_URL=https://aprscaching.net`,
  `RP_ID=aprscaching.net`, API host `api.aprscaching.net`, and the AGPL `/.well-known/source` link
  (ADR-3) point at `.net`.
- **WebAuthn gotcha (load-bearing):** passkeys are bound to a single `rpId`. `.com` must therefore be
  a *pure redirect*, never an origin a user signs in on — otherwise a passkey created on `.net`
  won't assert on `.com`. The pre-auth edge redirect guarantees every ceremony runs on `.net`.

## Entry routing — the landing gate
One decision at load, driven by **auth state** + an **explore intent**:

| State | What renders |
|---|---|
| **Signed in** (valid session) | The platform in **full mode**. Landing is **never shown.** |
| Signed out, no explore intent | The **landing page** (CTAs: Register · Login · Explore) |
| Signed out, explore intent set | The platform in **read-only mode** (+ quick tour) |
| After Register/Login success | The platform in **full mode** (skip landing) |

- **Explore intent** is a per-session flag (`sessionStorage`, e.g. `acs.explore=1`): once a signed-out
  user clicks **Explore**, they stay in the read-only app for that browser session (no re-walling on
  internal navigation), but a **fresh visit re-shows the landing** (it's marketing). Signing out
  clears it.
- **Register / Login** reuse the existing identity flow (`identity/SignIn.tsx` → session cookie); on
  success the landing is dismissed and the app is in full mode.
- Deep links (a shared cache/map URL, `docs/design/11` permalinks) bypass the landing → straight to
  read-only with that view, since the intent is explicit.

## Read-only mode — mostly already true
The SPA **already** allows open browsing: signing in only gates log/hide/announce (M9 S4), and
gated actions invoked while signed-out already route to `SignIn`. So "read-only mode" is the existing
open-browse behavior; the **new** mechanic is the landing front-gate plus making the signed-out
capability boundary legible (the tour does this). No backend change — read-only is the absence of a
session, which the gateway already enforces.

## Quick-tour framework (mechanics; steps deferred)
A reusable, **accessible** coach-mark/tour driven by a **steps config** (empty/placeholder now):
- Real semantics: a focus-trapped popover/dialog per step with real `<button>` next/prev/skip, ARIA,
  visible focus — **never a CSS-only `:target`/checkbox hack** (css.md).
- **Reduced-motion**: highlight/advance via opacity only; honor `prefers-reduced-motion`.
- **Remembered**: a `localStorage` "tour seen" flag so it auto-runs once (on first Explore) and is
  re-openable from a help affordance; never nags.
- **Config-driven**: `steps: [{ target, title, body, when: 'signed-out' | 'signed-in' }]` — the array
  is a stub now; the doc that fills it (copy + DOM targets) is **deferred**. The framework ships with
  ≤1 placeholder step so it's testable without committing content.

## Landing page shell (mechanics; content deferred)
- A **lightweight, code-split, SEO-able** entry **separate from the MapLibre bundle**, so marketing
  first-paint is fast and crawlable and the heavy app loads only on Explore/auth (lazy `import()`).
  (A simpler in-SPA overlay that defers map init until Explore is an acceptable v1 if the second
  build target is too much — but the code-split landing is preferred for perf/SEO.)
- Ships with a **structural skeleton only**: hero slot + the three CTAs wired, empty section slots,
  and OG/meta tag scaffolding. **All copy, the feature list, and screenshots are deferred.**
- Tokens only, responsive via container/media queries, dark+light, a11y. A *subtle*,
  reduced-motion-aware touch is permitted here (non-map view) — **no scroll-spectacle / parallax**
  (css.md).

## Rules / cost
- ui-ux: one unmistakable primary action on the landing (the CTA); progressive disclosure; the tour
  groups capability into signed-out vs signed-in rather than dumping a feature wall.
- css: landing and tour animate only `transform`/`opacity`, reduced-motion paths, no blur-over-map,
  no JS for what CSS expresses. The tour is a real semantic component.
- cost: read-only browse already runs against the open endpoints; the landing adds no backend.

## Milestones
- **L1 — domain/redirect infra (PENDING — deployment):** `.com` → `.net` edge 301 (pre-auth);
  `INSTANCE`/`APP_URL`/`RP_ID`/API host set to `.net`; ADR-3 source link host. Not app code.
- **L2 — landing gate + CTAs (DONE):** signed-in skips landing entirely; signed-out sees landing;
  Register/Login wired to the existing `SignIn`; signed-out gated actions route to sign-in.
- **L3 — Explore → read-only entry (DONE):** Explore dismisses the landing, sets the per-session
  explore intent, reveals the read-only platform; sign-out returns to the landing. (Deep-link bypass
  is the remaining nicety — currently a fresh visit shows the landing until Explore/sign-in.)
- **L4 — tour framework (DONE):** accessible, reduced-motion, remembered, config-driven, with a
  placeholder step; runs once on first Explore.
- **Deferred (content track, not now):** landing copy + feature list + screenshots; the tour step
  content + DOM targets + the signed-out/signed-in capability descriptions.

## Acceptance (mechanics)
- A **signed-in** user reaching `/` lands in the full platform; the landing never renders.
- A **signed-out** user sees the landing with Register / Login / Explore.
- **Explore** hides the landing and shows the platform read-only; within the session, navigation
  doesn't re-show the landing; a new session does.
- **Register/Login** success enters full mode and skips the landing.
- Hitting **`aprscaching.com`** lands on **`aprscaching.net`** before any auth/app code runs; a
  passkey created on `.net` asserts normally.
- The **tour** opens on first Explore, is keyboard-operable and dismissible, remembers "seen", and
  honors reduced-motion — with placeholder content (real steps deferred).
