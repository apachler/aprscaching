# Secrets and credentials

This page lists every secret an aprscaching instance holds: what it guards, where each deployment shape keeps
it, who must never hold it and how to change it. It also sets out how sessions end and who counts as a sysop.

## The secrets

| Secret | Guards | Required | Never give it to | Rotate with |
|---|---|---|---|---|
| `INGEST_SECRET` | The ingest plane (`x-ingest-secret`): see [Machine credentials](#machine-credentials) | yes: Node and Bun refuse to boot while it is unset or `change-me` | anyone but the gateway and its ingest boxes | `rotate-secret` |
| `OPERATOR_SECRET` | Instance-wide configuration from scripts (`x-operator-secret`) and the operator's one-time sign-in links | no: unset closes those machine paths; the web sysop surface still works | an ingest box | `rotate-secret` |
| `SESSION_SECRET` | The signature on every session cookie | for sign-in: unset, `change-me` or equal to another secret mints and honours no session | an ingest box | `rotate-secret` (signs every user out) |
| `FED_PRIVATE_KEY` | The Ed25519 key that signs this instance's federation feeds | no: without it feeds serve unsigned and peers do not mirror them | anyone; an ingest container runs without it | `tools/fedkey/rotatekey.mjs` |
| `FED_SUBMIT_SECRET` | Hub: who may register a new spoke's key with `POST /federation/submit`. Spoke: its push secret | no | anyone outside the hub and its spokes | `rotate-secret` |
| `FED_RELAY_SECRET` | Enqueueing on the rendezvous relay and reading its results | no | anyone outside the relay's participants | `rotate-secret` |
| `FED_CORROBORATION_SECRET` | Which peers `/federation/corroborate` answers (`x-fed-secret`); sent only to trusted `https` peers | no | untrusted peers | `rotate-secret` |
| `BOX_KEY` | An enrolled ingest box's own Ed25519 key; it signs the box's requests in place of `INGEST_SECRET` | no | anyone; it stays on that box | revoke the box in Instance admin and enroll it again |

The three plane secrets must differ: the Node and Bun servers refuse to boot on an `OPERATOR_SECRET` or
`SESSION_SECRET` equal to `INGEST_SECRET`. Generate each with `openssl rand -hex 32`.
`deploy/aprscaching doctor` fails on a secret that is weak, an example value or shorter than 16 characters.

Other credentials an instance may hold: `APRSIS_PASSCODE`, `IGATE_PASS` and `APRSIS_SERVICE_PASS` (APRS-IS
logins, public by design and never a proof of identity), `EMAIL_API_KEY`, `VAPID_PRIVATE`, `OKAPI_KEY`,
`TUNNEL_TOKEN` and `CF_API_TOKEN`. Each is described in [Configuration](configuration.md).

`ADMIN_CALLSIGNS` is not a secret, but it is security-critical: it decides who is a sysop
([Who is a sysop](#who-is-a-sysop)). It is read from the environment only and never settable at runtime.

## Where each shape keeps them

| Shape | Where the secrets live | How they are made |
|---|---|---|
| Self-host (Docker) | `deploy/.env` | `deploy/setup.sh` generates `INGEST_SECRET`, `OPERATOR_SECRET` and the federation key; the gateway generates `SESSION_SECRET`. The compose file blanks the operator and session secrets and the federation key for the ingest container. |
| Self-host without Docker | `deploy/.env` | Add them by hand, or with `deploy/aprscaching init baremetal`. Leave `SESSION_SECRET` empty and the gateway generates `data/session.secret`. |
| Pocket | `~/.aprscaching/.env` | The installer writes `INGEST_SECRET` and `OPERATOR_SECRET`; the gateway generates `session.secret` beside the database. |
| Desktop | the data directory | Generated on first start. |
| Cloudflare split | Worker secrets | `npx wrangler secret put <NAME>`; `deploy/cloudflare/deploy-cf.sh` asks for all three plane secrets. The Worker generates no `SESSION_SECRET` and mints no session without one. |
| Ingest box | the box's `.env` | `INGEST_SECRET` only, or the `BOX_ID` and `BOX_KEY` that [enrollment](../run/radios/ingest-box.md#enrolling-the-box) writes. Never `OPERATOR_SECRET` or `SESSION_SECRET`. |

A settings file holding secrets must be readable by its owner only; the doctor fails on any other mode.

## Machine credentials

Two shared secrets reach the gateway from machines, and they never overlap:

| Secret | Header | Authorises | Held by |
|---|---|---|---|
| `INGEST_SECRET`, or an enrolled box's key | `x-ingest-secret`, or a signed request ([Enrolling boxes on the gateway](../run/radios/ingest-box.md#enrolling-boxes-on-the-gateway)) | The ingest plane: `/ingest`, the outbox, BBS delivery and the FBB forwarding pool, reading the forwarding partner list, the NET/ROM node mirror, heard federation beacons and sync pages, the catalog importer, finds logged over APRS, remote-box polling and pairing | the ingest box |
| `OPERATOR_SECRET` | `x-operator-secret` | Instance-wide configuration from scripts: reading the Setup checklist (`GET /api/admin/setup`, which `deploy/aprscaching doctor` relays), `POST /verify/operator`, the one-time sign-in link (`POST /auth/operator-link`), `POST /federation/sync`, the peer list and trust, 44Net onboarding, forwarding partners and rules, the FBB federation enqueue, relay dispatch, donation confirms, licence-register imports | the operator |

The ingest secret never registers a device key, never verifies a callsign and never signs a session, so a
stolen ingest box cannot take over an account or the instance. A device key binds to a callsign only through
its holder's signed-in session. If an ingest secret may have leaked, rotate it and review `callsign_keys` for
keys their holders did not register.

The operator secret mints one-time sign-in links
([Off-grid sign-in](../run/day-to-day/sign-in-links.md#off-grid-sign-in)): on an instance with passkeys or
email, for `ADMIN_CALLSIGNS` calls only; on an off-grid instance, or with `OPERATOR_LINKS_FOR_ANY_CALL=1`, for
any account. Keep it on the gateway host. Leave it unset to close the machine paths altogether; the web
operator surface is unaffected.

## Who is a sysop

`ADMIN_CALLSIGNS` (comma-separated licensed calls) names the instance's operators. A signed-in account is a
**sysop** when all three hold:

1. its active callsign is in `ADMIN_CALLSIGNS`;
2. the account holds that call;
3. the call is **control-verified**, the same proof transmitting needs.

Signing up under a listed call grants nothing until that verification succeeds. The operator confirms their
own call once after the first sign-in, with the operator CLI
([Operator callsign](cli.md#operator-callsign)). It calls `POST /verify/operator` with the operator secret,
which verifies a call listed in `ADMIN_CALLSIGNS` (method `operator`) and nothing else.

`GET /api/admin/whoami` tells the web app whether to show the operator surface. For an account that holds a
listed call not yet confirmed, it answers `pending: "verify"`, and **Settings → Account** shows that operator
the commands. Nobody else learns anything about the list. With `ADMIN_CALLSIGNS` unset, the web operator
surface is locked entirely.

Every operator write is enforced by `requireSysop` on the server; hiding a control in the UI is never the
gate. The rule is the same on every runtime: the Node and Bun servers forward the complete set of
configuration keys to the gateway, so every deployment shape has the web sysop surface when the variable is
set.

## Sessions

A session names its account and that account's session generation. It is honoured only while the account
exists at that generation and still holds the session's call.

| Event | Effect |
|---|---|
| The account is erased | Every session of the account ends; its cookie never acts as the next holder of the same call |
| The active callsign changes | Every session of the account ends |
| **Settings → Account → Sign out everywhere** (`POST /auth/logout-all`) | Every session of the account ends |
| `SESSION_EPOCH` set to the current Unix time | Every session minted before it is refused: every user is signed out |
| `SESSION_SECRET` rotated | Every user is signed out |
| A manual callsign verification is revoked | Sessions continue: the account still holds the call. Transmitting and the sysop role check verification on every request |

A cross-origin request carries a session only from `APP_URL` or an origin in `CORS_ORIGINS`.

## Rotating a secret

```bash
deploy/aprscaching rotate-secret INGEST_SECRET
```

This replaces one secret with a fresh random value in the shape's settings (on Cloudflare, in the Worker's
secrets) after you confirm; `--yes` skips the question. Restart the instance to apply it. Desktop keeps its
secrets in its data directory and has no settings file for the command.

| Secret | What changes |
|---|---|
| `INGEST_SECRET` | Every ingest box needs the new value before it can post again. The command shows the value once, so you can copy it to the boxes |
| `OPERATOR_SECRET` | Scripts that send `x-operator-secret` need the new value |
| `SESSION_SECRET` | Every user is signed out |
| `FED_SUBMIT_SECRET` | The hub and every spoke must share the new value |
| `FED_RELAY_SECRET` | Every relay participant must share the new value |
| `FED_CORROBORATION_SECRET` | Trusted peers that ask for corroboration need the new value |

The federation signing key (`FED_PRIVATE_KEY`) is not rotated this way. `tools/fedkey/rotatekey.mjs` signs
the new key with the old one, so peers keep trusting it
([Signed feeds](federation-trust.md#signed-feeds)).

## Next

- [Configuration](configuration.md): every setting, secrets included.
- [The deploy/aprscaching command](../run/day-to-day/helper-command.md): the command that rotates them.
