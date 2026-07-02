# Administration

Some configuration governs the **whole instance** and belongs to the ham who deployed it — not to platform
users. This surface is separate from per-user settings and is gated server-side.

## Operator identity

`ADMIN_CALLSIGNS` (comma-separated licensed calls) names the instance operator(s). A signed-in account whose
active callsign is in that list is a **sysop**; `GET /api/admin/whoami` tells the web app whether to reveal
the operator surface. Every operator write is enforced by `requireSysop` on the server — hiding a control in
the UI is never the gate. If `ADMIN_CALLSIGNS` is unset, the web operator surface is locked entirely (the
operator-local ingest box can still act with `INGEST_SECRET`).

!!! warning
    `ADMIN_CALLSIGNS` is security-critical and env-only — it must never be settable at runtime. On the Bun
    single-binary topology this variable is not read, so that build has no web sysop surface.

## Operator-only surfaces

Reached from the instance-admin panel (shown only to operators):

- **Federation** — the peer list with health and reputation, per-peer **trust** (`trusted` / `unvetted` /
  `blocked`), and a manual sync trigger. See [Federation](../guides/federation.md).
- **FBB forwarding** — partner BBSes (callsign, protocol, intervals, time-bands, message types) and
  hierarchical routing rules, plus the White Pages directory that steers personal mail.
- **NET/ROM node** — the learned NODES routing table.
- **Ingest & transports** — the data plane (transports and the TAK/CoT feed). `GET /api/cot?bbox=` renders
  the live station registry as Cursor-on-Target for ATAK / WinTAK / iTAK.

Everything a normal user does — hiding and logging caches, favorites and ratings, callsign management,
preferences, media, enabling tools, and their own data actions — is **not** on this surface.

## Remote control of your box

You can drive your own ingest box from the web app without opening any inbound port: the app enqueues
commands and the box pulls them over its existing outbound connection (`/api/box/:id/*`). Read-only commands
need only a session; any transmit command requires a **verified callsign**.

## Data protection (GDPR / DSGVO)

Sensitive account actions are authorised by a passkey session or a signature from a device key registered to
the callsign — there is no central password.

- **Export** (`POST /api/account/:call/export`) returns a full machine-readable copy of the account's data.
- **Erase** (`/delete`) anonymises finds to `WITHDRAWN`, archives owned caches, deletes personal rows, and
  emits a **PII-free tombstone** so federation peers purge their mirrored copies.
- **Portability** (`/bundle`, `/move`, `/api/account/import`) lets a user migrate a callsign to another
  instance; because finds are device-signed, history stays attributable, and an account-move record
  re-points attribution across the network.

Positions are TTL'd; the retained record is public ham identifiers and APRS positions that are public by
design on RF/APRS-IS. Set `TOMBSTONE_TTL_DAYS` for how long deletes are retained for peer convergence.
