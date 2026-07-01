# Profiles — a thin, opt-in ham profile (borrow QRZ's idea, not its directory)

Decision from the QRZ.com review: **adopt a self-curated community profile, reject the callsign-
directory data.** QRZ exists to *publish* hams' legal name + postal address (sourced from US FCC-
style public license databases); we are a caching game + APRS workbench, not a lookup service, and
we operate under EU/DSGVO where regulator data is not freely republishable. So we keep the
*recognition* layer and drop the PII. Build against `.claude/rules/ui-ux.md` + `.claude/rules/css.md`.

## Principle
- **Callsign is the public identity.** Control-verification already proves the licensee without
  storing their name or address — so we never collect either. Data-minimization is the rule.
- **Everything public is opt-in and user-edited.** No field is shown unless the user fills it in.
- **We already beat QRZ on auth + rights:** passwordless (passkey + email magic-link, no central
  password), and GDPR export/erase already cover the `accounts` row. Don't regress.
- **No ads, no third-party analytics** (consistent with `docs/12`). One session cookie only.

## Fields
| Field | State | Public? |
|---|---|---|
| `display_name` | **exists** (`accounts.display_name`) | opt-in, default callsign only |
| `home_grid` (Maidenhead locator) | **exists** (`accounts.home_grid`) | opt-in |
| `avatar` | **add** — small image in R2 (media plumbing exists) | opt-in |
| `bio` | **add** — short **plain-text**, length-capped (NOT QRZ's free HTML — XSS/moderation burden) | opt-in |
| `links` | **add** — a few labelled URLs (QRZ page, website) | opt-in |
| operated SSID stations (`OE8APR-9`…) | **deferred** — needs `account_stations` (see `docs/10`) | opt-in |
| public contact email | **add** — explicit opt-in field, **default off**; the account email stays private (magic-link only) and is never shown | opt-in |

Rejected outright: legal name, postal address, license-database import, passwords, QSL-image manager,
a separate QSO logbook (we already have the *find* logbook).

## Schema (one small migration, next free number)
```sql
ALTER TABLE accounts ADD COLUMN avatar_url      TEXT;     -- R2 key/url, opt-in
ALTER TABLE accounts ADD COLUMN bio             TEXT;     -- short plain text, length-capped server-side
ALTER TABLE accounts ADD COLUMN links           TEXT;     -- JSON: [{label,url}], capped count
ALTER TABLE accounts ADD COLUMN public_contact  TEXT;     -- opt-in public email; NULL = not shown
ALTER TABLE accounts ADD COLUMN profile_public  INTEGER NOT NULL DEFAULT 1; -- master show/hide
```
`display_name` + `home_grid` already exist. All of it lives inside the existing GDPR export/erase.

## API
- `GET /api/profile/:call` — **extend** the existing response to include the opt-in profile fields
  (display_name, home_grid, avatar, bio, links, operated stations, public_contact) alongside the
  finds/points/badges it already returns. Omit any field the user left empty/private.
- `POST /auth/profile` (session-gated) — update your own profile; server validates/sanitizes bio
  length, link count, and URL scheme; avatar via the R2 media path.

## UI
- A grouped, collapsible **Settings → Profile** section (ui-ux §2): display name, locator, avatar,
  bio, links, public-contact toggle, and a master "show my profile publicly" switch. Each field has
  a sensible default and one-line help; nothing is a wall of inputs.
- The public profile page renders only filled, public fields; empty state is just the callsign +
  stats (today's behaviour).

## Rule compliance
- ui-ux: opt-in, grouped, toggle-gated; master switch collapses children when off. Profile never
  clutters the cacher's default map.
- css: avatar/layout responsive via container queries; no inline styles; tokens only.
- Security/privacy: server-side sanitize bio (escape/strip), validate link URLs (http/https only),
  cap counts; public_contact and each field default to **not shown**.

## Milestone
- **M4** (community): display_name + home_grid + bio + links surfaced on the profile; Settings →
  Profile group; public/private toggles. Avatar (R2) fits here too.
- **M5**: operated **SSID stations** on the profile, once `account_stations` lands (`docs/10`).

## Account UI-preferences sync (DONE)
Device-independent UI settings follow the **account**, not the browser, so signing in on a second
device restores them. localStorage stays the single source of truth for the running app; a thin
sync layer mirrors a known subset to the account: **theme + units/locale** (`acs.locale`), **pinned
workbench apps** (`acs.pins`), and **basemap** (`acs.basemap`). Server: `account_prefs` (migration
`0039`, keyed by `account_id` per ADR-1/ADR-2) + `GET`/`PUT /api/prefs` (session-gated, validated,
size-capped). Client: `pullPrefs()` on sign-in (seeds the account from this device on first use),
debounced `notePrefChange()` push on change; guests are untouched (endpoint 401s). Inside the GDPR
export/erase. Saved *map views* remain their own shareable, slug-addressed store (`docs/11` M1).

## Acceptance
- A signed-in user can set a display name, locator, avatar, bio, and links; each is shown publicly
  only when filled and not hidden.
- UI prefs (theme, units, pinned apps, basemap) set on one device reappear after signing in on
  another; a signed-out user's prefs stay local; prefs are in the GDPR export and removed on erase.
- The account (magic-link) email is never shown; a public contact appears only if explicitly opted in.
- No legal name / address is ever collected or displayed.
- Profile data is included in GDPR export and removed on erase.
- Bio with markup is rendered as inert text; a non-http link is rejected.
