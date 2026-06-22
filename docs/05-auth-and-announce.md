# Auth + APRS-IS Announce — design addendum

## Two orthogonal trust signals
- **Position tier (A/B/C)** — was the find physically corroborated? (verify.ts)
- **Account verification** — does this person actually hold this callsign? (auth + callsign.ts)
A gold-standard find = verified account + Tier A. Neither blocks the act of logging.

## Auth (identity) — logging stays one tap
- Identity = **callsign + passkey (WebAuthn)**. First use *claims* the callsign and binds it to a
  passkey, preventing impersonation. Magic-link email = fallback.
- `POST /auth/claim {callsign}` -> register or login ceremony.
- `POST /auth/passkey/verify` -> issues a signed session cookie.
- Logging prefers the **session callsign**; unverified/anonymous logs are still accepted but flagged.
- TODO: plug a WebAuthn library into auth.ts (verify edge-runtime support).

## Callsign-control verification (the badge) — async, never gates logging
- `POST /verify/aprs/start {callsign}` -> queues a one-time code as an **APRS message** to the
  callsign (delivered via the outbox). `POST /verify/aprs/confirm {callsign, code}` -> verified.
- Alternatives to add: LoTW / QRZ / TX-challenge (token heard by an independent IGate).
- Verified status gates the **announce** feature and (optionally) competitive leaderboard credit.

## APRS-IS announce (optional) — publish a find to APRS-IS
- **Opt-in** (`accounts.announce_is`) AND **verified callsign** only.
- Publishes a **STATUS** (not a position): `>Found AC-1234 (Title) via aprscaching.com`.
- Internet injection, **not** an RF transmission -> Part 97 TX rules don't apply to it. RF announce
  is the separate, license-gated M5 path.
- Flow: Worker `maybeAnnounceFind` -> `aprs_outbox` -> ingest box polls `/outbox` -> publishes via
  **third-party format** under a single service login (user stays the inner source) -> `/outbox/ack`.
- Tocall **APZACG** (experimental) until a real aprscaching tocall is registered.
- **Excluded from verification**: announces are status packets, and `handleLogFind` ignores
  `positions.source='service'`, so our own injections can never become someone's corroboration.
- Etiquette: opt-in, rate-limited (one status per find), no impersonation.
