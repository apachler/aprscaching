# Secrets and credentials

Every secret an instance holds, what it guards and how to change it.

## The three secrets

!!! warning "Three distinct secrets"
    | Secret | Gateway | Ingest box | If unset |
    |---|---|---|---|
    | `INGEST_SECRET` | required | required (the same value) | Node/Bun refuse to boot |
    | `OPERATOR_SECRET` | optional | **never** | operator scripts (`tools/admin/*`) are refused; the web sysop surface still works |
    | `SESSION_SECRET` | required for sign-in | **never** | Node/Bun/desktop generate one beside the database; the Worker mints no session |

    The three must differ from each other; the Node/Bun servers refuse to boot on an `OPERATOR_SECRET` or
    `SESSION_SECRET` equal to `INGEST_SECRET`. Generate each with `openssl rand -hex 32`.

    - **Self-host (Docker):** `deploy/setup.sh` generates `INGEST_SECRET` and `OPERATOR_SECRET` in
      `deploy/.env` and leaves `SESSION_SECRET` for the gateway to generate; the compose file blanks the
      operator and session secrets (and the federation key) for the ingest container.
    - **Cloudflare split:** `npx wrangler secret put INGEST_SECRET`, `… OPERATOR_SECRET` and `… SESSION_SECRET`
      (`deploy/cloudflare/deploy-cf.sh` asks for all three).
    - **systemd / bare metal:** add them to `deploy/.env`; leave `SESSION_SECRET` empty to have the gateway
      generate `data/session.secret`.
    - **Desktop:** generated on first run into the data directory.

## Operator scripts, sessions and remote boxes

- **`OPERATOR_SECRET`** is needed on the gateway if you run `tools/admin/verify-call.mjs`, change peer trust
  or forwarding partners/rules from scripts, or confirm donations. Those calls authenticate with
  `x-operator-secret`; the ingest secret does not reach them.
- **`SESSION_SECRET`** must be set on the Worker (`npx wrangler secret put SESSION_SECRET`); the Node/Bun
  servers generate one on first start when it is unset. A session binds to its account, and a cookie without
  that binding is not accepted, so changing `SESSION_SECRET` signs every user out once.
- **Remote boxes are paired.** A box answers only the account it is paired to: the ingest box prints a
  pairing code when it starts, which you enter under **Shack → Remote box**.
- **Dev setups with the SPA on another origin** (`pnpm dev:web`) set `CORS_ORIGINS=http://localhost:5173`
  on the gateway; without an allowlist no cross-origin request carries a session.
- A device key binds only through its holder's signed-in session. If an ingest secret may have leaked,
  rotate it and review `callsign_keys` for keys their holders did not register.

## Who is a sysop

`ADMIN_CALLSIGNS` (comma-separated licensed calls) names the instance operator(s). A signed-in account is a
**sysop** when its active callsign is in that list, the account holds that call, and the call is
**control-verified** — the same proof transmit needs. Signing up under a listed call grants nothing until
that verification succeeds, so the operator confirms their call once after first sign-in, with the operator
CLI:

```bash
docker compose exec gateway node tools/admin/verify-call.mjs OE8APR                   # Docker stack, from deploy/
BASE=https://api.example.net OPERATOR_SECRET=… node tools/admin/verify-call.mjs OE8APR   # from a checkout
```

It calls `POST /verify/operator` with the operator secret (`x-operator-secret`), which verifies a call listed in `ADMIN_CALLSIGNS`
(method `operator`) and nothing else. `GET /api/admin/whoami` tells the web app whether to reveal the operator
surface; for the account that holds a listed call not yet confirmed it answers `pending: "verify"`, and
**Settings → Account** shows that operator both commands. Nobody else learns anything about the list. Every operator write is enforced by `requireSysop` on the server — hiding a control in
the UI is never the gate. If `ADMIN_CALLSIGNS` is unset, the web operator surface is locked entirely.

## Machine credentials

Two shared secrets reach the gateway from machines, and they never overlap:

| Secret | Header | Authorises | Held by |
|---|---|---|---|
| `INGEST_SECRET`, or an enrolled box's key | `x-ingest-secret`, or a signed request ([Enrolling ingest boxes](../run/radios/ingest-box.md#enrolling-boxes-on-the-gateway)) | The ingest plane: `/ingest`, the outbox, BBS delivery and the FBB forwarding pool, reading the forwarding partner list, the NET/ROM node mirror, heard federation beacons and sync pages, the catalog importer, finds logged over APRS, remote-box polling and pairing | the ingest box |
| `OPERATOR_SECRET` | `x-operator-secret` | Instance-wide configuration from scripts: reading the Setup checklist (`GET /api/admin/setup`, which `deploy/aprscaching doctor` relays), `POST /verify/operator`, the one-time sign-in link (`POST /auth/operator-link`), `POST /federation/sync`, the peer list and trust, 44net onboarding, forwarding partners and rules, the FBB federation enqueue, relay dispatch, donation confirms, licence-register imports | the operator |

The ingest secret never registers a device key, never verifies a callsign and never signs a session, so a
stolen ingest box cannot take over an account or the instance. The operator secret mints one-time sign-in
links ([Off-grid sign-in](../run/day-to-day/sign-in-links.md#off-grid-sign-in)): on an instance with passkeys or email only for
`ADMIN_CALLSIGNS` calls, on an off-grid instance for any account — keep it on the gateway host. Leave `OPERATOR_SECRET` unset to close the
machine paths altogether; the web operator surface is unaffected. Sessions are signed with the separate
`SESSION_SECRET`.

## Sessions

A session names the account behind it and that account's session generation, and is honoured only while
the account exists at that generation and still holds the session's call. Erasing an account, changing the
active callsign, and **Settings → Account → Sign out everywhere** (`POST /auth/logout-all`) each end every
outstanding session of that account; an erased account's cookie never acts as the next holder of the same
call. To sign out every user at once, set `SESSION_EPOCH` to the current Unix time or rotate
`SESSION_SECRET`. Revoking a manual callsign verification does not end sessions — the account still holds
the call, and transmitting and the sysop role check verification on every request.

!!! warning
    `ADMIN_CALLSIGNS` is security-critical and env-only — it must never be settable at runtime. It works
    identically on every runtime (Worker, Node, Bun): the self-host servers forward the complete config-key
    set into the gateway, so every deployment shape has the web sysop surface when the variable is set.

## Rotating a secret

```bash
deploy/aprscaching rotate-secret INGEST_SECRET
```

This replaces one secret with a fresh random value in the shape's settings, after you confirm. Restart the
instance to apply it. What changes when you rotate:

| Secret | Effect |
|---|---|
| `INGEST_SECRET` | Every ingest box needs the new value before it can post again. The helper shows the value once, so you can copy it to the boxes |
| `OPERATOR_SECRET` | Scripts that send `x-operator-secret` need the new value |
| `SESSION_SECRET` | Every user is signed out |
| `FED_SUBMIT_SECRET`, `FED_RELAY_SECRET` | The hub and every spoke must share the new value |
| `FED_CORROBORATION_SECRET` | Trusted peers that ask for corroboration need the new value |

The federation signing key (`FED_PRIVATE_KEY`) is not rotated this way. Use `tools/fedkey/rotatekey.mjs`,
which signs the new key with the old one so peers keep trusting it.

## Next

- [Configuration](configuration.md).
