# Security Policy

aprscaching ingests hostile input by design — RF packets from anyone with a transmitter, and
federation traffic from peers we don't control. We take reports seriously.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ security fixes |
| < 1.0   | ❌ pre-release, unsupported |

Self-hosters: run a supported version, and because the app is AGPL, keep your published source
(`SOURCE_REPO`) current so your users can see what you're running.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use a private channel:

1. **Preferred:** GitHub → the repository's **Security** tab → **Report a vulnerability** (private
   security advisory). This keeps the report confidential and lets us collaborate on a fix.
2. **Email fallback:** `apachler@paan-systems.com` with `SECURITY` in the subject.

Please include: what you found, the affected component/endpoint, a reproduction (a crafted packet, a
request, a malicious-peer scenario), the impact, and any suggested fix. We'll acknowledge within a few
days and keep you updated through disclosure. Coordinated disclosure is appreciated — we'll credit you
unless you prefer to stay anonymous.

## Scope — what we especially care about

Given the threat model (hostile RF, hostile peers, a public read API, unattended 24/7 boxes):

- **Trust-model bypass** — anything that lets a find reach Tier A/B without genuine corroboration
  (`workers/gateway/src/verify.ts`, `caches.ts`, `corroborate.ts`).
- **Federation** — signature/replay/namespace attacks, tombstone forgery, peer impersonation or
  key-rotation bypass (`federation*.ts`, `tombstones.ts`).
- **Auth & sessions** — WebAuthn/passkey flows, the magic-link path, session forgery, callsign
  control-verification: the on-air `VERIFY` challenge (APRS and MeshCom — any way to make a copy that no
  attested site heard directly count), the ampr.org DNS method (anything that verifies without a
  DNSSEC-validated answer, `verify_ampr.ts`), the LoTW certificate method (a signature, chain, date or
  callsign check that can be bypassed, or a certificate parser crash — `verify_lotw.ts`, `x509.ts`), the
  operator bootstrap, and sysop manual verification.
- **Ingest & parsers** — a single crafted packet that crashes or hangs the ingest/gateway
  (`packages/aprs`, `packages/packet`, `apps/ingest`).
- **The tool-plugin sandbox** (`packages/tools`, `apps/web/src/tools/`) — sandbox escape or
  signature-verification bypass.
- **Resource exhaustion** — unbounded growth or connection storms that take down a long-running box.

Out of scope: findings that require a secret the operator already controls (e.g. `OPERATOR_SECRET`,
`SESSION_SECRET`, `FED_PRIVATE_KEY`), self-inflicted misconfiguration, or volumetric DoS against a public instance's
network layer (that's the operator's edge/CDN concern).

## Hardening & running securely

- **Three secrets, three planes.** `INGEST_SECRET` (the ingest box) authorises only ingest-plane writes;
  it never registers a device key, verifies a callsign, reaches operator configuration or signs a
  session. `OPERATOR_SECRET` (the operator's scripts, `x-operator-secret`) reaches instance-wide
  configuration and is closed while unset. `SESSION_SECRET` alone signs sessions. A leaked ingest secret
  therefore lets an attacker post packets as your ingest box — it does not hand over accounts or the
  instance, and a finding that it does is in scope.
- The Node/Bun servers **refuse to boot** with an unset or default (`change-me`) `INGEST_SECRET`, or an
  `OPERATOR_SECRET`/`SESSION_SECRET` equal to it. Without `SESSION_SECRET` they generate one beside the
  database; the Worker mints no session without it. Give an ingest box only `INGEST_SECRET`.
- **Sessions are bound to the account.** A cookie names the account and its session generation and is
  honoured only while that account exists at that generation and holds the call. Erasure, a callsign
  change and **Sign out everywhere** (`POST /auth/logout-all`) end every session of the account;
  `SESSION_EPOCH` ends every session on the instance.
- **Sign-in needs a deliberate step.** Opening an email sign-in link shows the gateway's confirm page;
  only its POST (same origin) spends the token, so a page cannot log a visitor into someone else's account.
- **One record per identity fact.** `account_callsigns` alone says who holds a licence (one account per
  base call) and `callsign_verifications` alone says whether its control is proven; every check reads
  them, so no copy can disagree. A claim of a call nobody held starts unverified.
- **Ownership follows the licence.** A cache, its stages and media, and a saved view belong to the
  account holding the owner call's base call; a different account never acts as owner by presenting the
  call string. Only the ingest plane acts for an owner without a session, naming that exact call.
- **Credentialed CORS is allowlisted.** Only `APP_URL` and `CORS_ORIGINS` may send a session cookie
  cross-origin; with neither set, no origin can.
- **A remote box belongs to the account that pairs it** with the one-time code the box prints; no
  account can claim a box id by touching it first.
- The desktop app listens on `127.0.0.1` unless `HOST` says otherwise, and generates its secrets on first
  run.
- `LOTW_CA_PEM` decides whose certificates prove a callsign: put only the ARRL LoTW CA certificates in
  it, checked against a second independent copy. `DOH_URL` must name a DNSSEC-validating resolver you
  trust, since its AD flag is what the ampr.org method relies on.
- Keep secrets out of the repo (`FED_PRIVATE_KEY`, `INGEST_SECRET`, `OPERATOR_SECRET`, `SESSION_SECRET`,
  VAPID keys, etc.) — use
  `wrangler secret` / environment variables. GitHub **secret scanning** is enabled on this repo;
  rotate anything it flags.
- A full reliability/security hardening pass was completed ahead of going public — every finding
  (Critical through Low) was fixed with a regression test. Deferred capability work is tracked openly
  in [`TODO.md`](TODO.md).

Thank you for helping keep the open network safe.
