# Instance admin at a glance

Some configuration governs the **whole instance** and belongs to the ham who deployed it — not to platform
users. This surface is separate from per-user settings and is gated server-side.

## Operator-only surfaces

Reached from the instance-admin panel (shown only to operators):

- **Callsign verification** — verify a call by hand, list and revoke manual verifications (above).
- **Cache adoption** — offer caches for adoption, decide requests, assign an owner (above).
- **Federation** — the peer list with health and reputation, per-peer **trust** (`trusted` / `unvetted` /
  `blocked`), and a manual sync trigger. See [Join the network](../federation/index.md).
- **FBB forwarding** — partner BBSes (callsign, protocol, intervals, time-bands, message types) and
  hierarchical routing rules, plus the White Pages directory that steers personal mail.
- **NET/ROM node** — the learned NODES routing table.
- **Ingest & transports** — the data plane (transports and the TAK/CoT feed). `GET /api/cot?bbox=` renders
  the live station registry as Cursor-on-Target for ATAK / WinTAK / iTAK.

Everything a normal user does — hiding and logging caches, favorites and ratings, callsign management,
preferences, media, enabling tools, and their own data actions — is **not** on this surface.

## Next

- [The deploy/aprscaching command](helper-command.md).
