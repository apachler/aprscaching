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
- **Auth & sessions** — WebAuthn/passkey flows, the magic-link path, session forgery, the APRS
  control-verification challenge.
- **Ingest & parsers** — a single crafted packet that crashes or hangs the ingest/gateway
  (`packages/aprs`, `packages/packet`, `apps/ingest`).
- **The tool-plugin sandbox** (`packages/tools`, `apps/web/src/tools/`) — sandbox escape or
  signature-verification bypass.
- **Resource exhaustion** — unbounded growth or connection storms that take down a long-running box.

Out of scope: findings that require a secret the operator already controls (e.g. `INGEST_SECRET`,
`FED_PRIVATE_KEY`), self-inflicted misconfiguration, or volumetric DoS against a public instance's
network layer (that's the operator's edge/CDN concern).

## Hardening & running securely

- The Node/Bun servers **refuse to boot** with an unset or default (`change-me`) `INGEST_SECRET`, and
  no session is minted on a weak secret. Set a strong secret (`openssl rand -hex 24`); on a shared
  gateway also set a dedicated `SESSION_SECRET`.
- Keep secrets out of the repo (`FED_PRIVATE_KEY`, `INGEST_SECRET`, VAPID keys, etc.) — use
  `wrangler secret` / environment variables. GitHub **secret scanning** is enabled on this repo;
  rotate anything it flags.
- A living reliability/security audit lives in [`STABILITY-REVIEW.md`](STABILITY-REVIEW.md) with stable
  `SR-*` finding IDs; the Critical and High items are fixed, and remaining items are tracked openly.

Thank you for helping keep the open network safe.
