# M9 — Identity & Auth (passkey + email; sign-in required to log)

Build real accounts on top of today's placeholder (callsign-in-localStorage). Decisions locked with
the author:

1. **Login = passkey (WebAuthn) + email magic-link recovery.** Passwordless. First use claims a
   callsign and binds a passkey; return visits assert the passkey → session cookie. Email magic-link
   is the recovery / no-authenticator fallback.
2. **Sign-in is REQUIRED to log a find** (and to hide a cache). This changes the old "logging is
   never blocked" stance: the act of logging now needs an authenticated session. (Browsing the map
   stays open.)
3. **One active callsign per account, changeable + re-verify.** The account is the durable identity
   (surrogate `account_id`); the callsign is a mutable, uniquely-held attribute. Changing it sets it
   `pending` and re-runs callsign-control verification (APRS message-challenge); announce + leaderboard
   credit gate off until re-verified.
4. **Callsign field moves out of the header → Settings → Account.** The header becomes a sign-in
   chip (signed-out → "Sign in"; signed-in → callsign + menu).

## Multiple callsigns & SSIDs — the ham-correct identity model
A person (account) is **not** one callsign. In APRS/AX.25 a callsign carries an **SSID 0–15**
(`OE8APR`, `OE8APR-9`, …) where the **base callsign is the license** and the **SSID is a
station/role** the same licensee runs — by convention: `-0` home, `-5` app/phone, `-7` HT, `-9`
primary mobile, `-10` IGate, `-11` balloon/air, `-13` weather, `-15` generic/HF. So:

- **Account = person** (durable `account_id`, passkey + email).
- Account holds **one or more *base* callsigns**, each independently **verified** (the APRS
  message-challenge / LoTW proves control of the *license* = the base call). A club call or a
  second-country call is just another verified base call on the same account.
- Each verified base call covers **all its SSID stations** (`OE8APR`, `OE8APR-9`, `OE8APR-7`…) — no
  per-SSID re-verification; same license. Users register the SSIDs they operate (for the picker)
  and pick which station they're **operating as** when they log/beacon.
- **Attribution:** a find/hide stores the exact operating callsign incl. SSID (audit + role), while
  **credit/leaderboard aggregate at the account / base-call level** (the person). Device-key
  signatures are per-account, so authorship is cryptographic regardless of which SSID was on air.
- **"Changing" your callsign** = selecting a different call you already hold, or **adding** a new
  base call (→ verify it). Nothing is rewritten; history stays under the call it was made on
  (preserves per-callsign federation signatures). This supersedes the earlier "1 callsign, destructive
  change" framing.

Schema direction (lands with the account-id/passkey milestone): `account_callsigns(account_id,
callsign, verified, method, verified_at, is_primary)` for verified base calls + `account_stations
(account_id, callsign_ssid, label, role)` for the SSID stations; `cache_logs.logger_call` keeps the
full operating callsign; credit joins through `account_callsigns` to the account.

**Phase 1 (now, pre-account-backend):** the web identity store holds a **list of callsigns with an
active selection** (localStorage), the callsign field moves to Settings → Account, and the **real**
`/verify/aprs` challenge is wired per base call. This is forward-compatible with the model above.

## The migration problem (why this is more than a settings edit)
`accounts.callsign` is the PRIMARY KEY and is denormalised as a string across `caches.owner_call`,
`cache_logs.logger_call`, `callsign_keys`, leaderboard/profile, BBS, federation namespacing. So a
durable account that can rename its callsign needs a **surrogate `account_id`**; callsign becomes a
unique attribute. Historical rows keep the callsign they were written with (audit-true); credit and
ownership follow the account via `account_id`. A `callsign_history` row records each change.

## Test strategy (keep dual-runtime conformance green)
WebAuthn can't be driven by the Node-fetch smoke suite (no authenticator). The **email-token flow is
headless-exercisable**: `POST /auth/email/start` → the token lands in a dev sink (returned in
non-prod / written to `aprs_outbox`-style table) → `POST /auth/email/verify` → session cookie. Smoke
tests authenticate via that path before logging. So we gate logging only *after* this exists, and the
smoke suite is updated in the same commit.

## Status
**S1–S5 are implemented and CI-green.** Passkey (WebAuthn) ceremonies verify on workerd + Node with
Web Crypto (no deps), browser-verified via a Playwright virtual authenticator; web sign-in (passkey +
email magic-link) drives a real session; web logging/hiding is gated behind that session while the
over-APRS path stays open via the ingest secret; and the active callsign can be changed (re-binding
the session and resetting verification to pending).

**Multiple verified base calls per account is implemented.** Migration `0011` adds `account_callsigns`
(the held base-call set keyed by `account_id`, with a unique index so a call is held by one account
only); `accounts.callsign` stays the active-call anchor and `account_id` the durable id. Endpoints:
`GET /auth/callsigns` (held set + which is active/primary), `POST /auth/callsigns` (add a base call,
held + unverified, no switch), and a reworked `POST /auth/callsign` that **switches non-destructively**
— moving to a call the account already holds restores that call's prior verification (no re-challenge),
while moving to a new base call adds it unverified. Passkeys stay bound to the primary call (login is
by the primary), so switching the active call no longer moves credentials. Verifying a call mirrors
its `verified` state onto `account_callsigns` so it survives switches. Settings → Account lists the
held calls with per-call verify / set-active and an "Add a callsign" disclosure. Smoke covers
hold → verify → switch-away → switch-back-preserves-verification, add, and the
held-by-another-account guards on both runtimes.

Decided (`docs/14`, ADR-1/ADR-2):
- **Leaderboard credit (ADR-1):** leaderboards **rank by callsign**; a person's **own profile sums**
  all their verified held calls (aggregate over `account_callsigns`). A find is credited **once** to
  the logging call (control-verification-gated, as today) — no double-counting, no schema change. An
  optional future "show as one operator" de-duped board may follow.
- **Callsign reassignment (ADR-2):** authorship belongs to the **account, not the call string**. A
  reassigned call starts fresh for the new holder; the prior holder keeps their finds, shown under
  the call **as held at the time**. Attribute finds by `(account_id, callsign, timestamp)` and
  resolve display via `callsign_history` time windows — **never join on the bare call string**.
  Every find-writing path must stamp `account_id`; per-account Ed25519 signing already makes
  authorship provable across reassignment.

Still deferred: **SSID station registry** (`account_stations` — the per-SSID picker; base-call
verification already covers all SSIDs, this is operating-station UX only).

**Leaderboard credit now gates on control-verification.** Competitive standings only count finds
whose `logger_call` is control-verified (APRS message-challenge / LoTW) — an unverified callsign
earns no leaderboard points, closing the anti-gaming gap. Personal profiles and badges still show
all of a caller's finds (your own record is yours regardless of verification); only the public
ranking is gated. Smoke covers it: an unverified `DL1ABC` is absent from the board, then verifies
via the real APRS challenge (start → read the outbox code → confirm) and ranks.

## Sequencing (each step independently committable + CI-green)
- **S1 — schema + email/session backend** (additive; nothing gated yet): migration `0010` adds
  `account_id` surrogate + `email` on accounts, `webauthn_credentials`, `auth_challenges`,
  `email_tokens`, `sessions` (or stateless signed cookie), `callsign_history`. Implement the
  email-magic-link ceremony + signed session cookie (`auth.ts` already has the HMAC session helper +
  `sessionCallsign`). Add a smoke test for register-via-email → session. Runs on Worker + Node.
- **S2 — WebAuthn (passkey)**: register/login ceremonies verified with Web Crypto (runtime-agnostic:
  identical on workerd + Node) — ES256 assertion + attestation parse (CBOR/COSE), challenge/origin/
  rpId checks, signCount replay guard. Browser-verified with a Playwright virtual authenticator.
- **S3 — web sign-in UI + move callsign to Account settings**: passkey create/get via
  `navigator.credentials`, email fallback; header sign-in chip; callsign read-only in Settings →
  Account. Logging still works unauthenticated at this point (backend not yet gated).
- **S4 — gate logging/hiding behind the session** + update the smoke suite to authenticate first.
  Server attributes logs to the **session** callsign (ignores body callsign). 401 when signed out;
  the web routes the user to sign-in.
- **S5 — change-callsign + re-verify**: Account-settings flow (new callsign → pending → APRS
  re-challenge → active); credit/announce gated until verified; `callsign_history` audit.

> Security notes: cookies `HttpOnly; Secure; SameSite=Lax`; bind WebAuthn to the deployment origin/
> rpId via config; rate-limit email-token + challenge endpoints; never let a session alone upgrade a
> find's trust tier (position tiers stay independent of account verification).
