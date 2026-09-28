# MeshCom transmit channel (design)

!!! note "Agreed design"
    Nothing on this page is built. It is the agreed design for how features on the gateway ask an operator's
    ingest box to send a MeshCom message through `MeshcomSender`.

## The problem

`MeshcomSender` (`apps/ingest/src/meshcom-send.ts`) can hand a text message to a MeshCom node, but nothing
calls it: the features that would — replies from the Messages surface, confirmations for finds logged over
the mesh — run on the gateway, and the box has no way to receive a request from it.

One constraint shapes everything: **a MeshCom node transmits every message under its own callsign.** Whoever
asks the box to send, the frame goes out as the node owner's station, and the node owner is the control
operator. The channel therefore has to guarantee that the node owner authorised the message.

## What exists

| Channel | Direction | Auth | Consumer on the box |
|---|---|---|---|
| `aprs_outbox` (`/outbox`, `/outbox/ack`) | gateway → box | `INGEST_SECRET` | the APRS-IS uplink drains `target = 'is' \| 'cwop'` |
| `box_commands` (`/api/box/:id/commands`, `/commands/ack`) | gateway → one box | enqueue: owner session (TOFU) or secret, TX kinds need a control-verified call the account holds; poll: `INGEST_SECRET` | **none** — the box never polls it |

The outbox is instance-wide: any feature can queue, and whichever box holds the secret sends. That fits
APRS-IS, where the uplink logs in with its own service identity, but not MeshCom, where the sender's identity
is the node's.

`box_commands` is per box and per owner, with the right gate — a TX command must name a verified callsign
held by the account that owns the box — but the box side was never built.

## Proposal

Use `box_commands`, and build its box side.

1. **Box identity.** The ingest box gets `BOX_ID` (a random id the operator sets once; the box's log prints a
   suggestion when unset). The first signed-in account that enqueues to it owns it (existing TOFU rule).
2. **Poller.** When `BOX_ID` is set, the box polls `GET /api/box/:id/commands` every few seconds over its
   existing outbound connection and acks each command with `done` / `failed` and a result string. This also
   gives the existing Remote box surface its missing half.
3. **New command kind `meshcom_msg`** (a TX kind): `{ dst, text, feature }`. The gateway checks it like every
   TX kind — a verified callsign held by the box owner — and additionally that the callsign's base call equals
   the base call of a MeshCom node the box reported (see 5). The box runs it through `MeshcomSender`, which
   repeats the checks locally (enabled, operator call = node call, callsign destination, rate limit) and acks
   `handed-to-node` or the refusal reason.
4. **Features.**
    - **Reply from Messages** — a user replying to a MeshCom direct message that their own node heard enqueues
      `meshcom_msg` to their own box. Other users cannot, because they don't own that box.
    - **Find confirmation** — when a find is logged by a MeshCom `FOUND <code>` message that the box owner's
      node heard, the gateway enqueues a confirmation *to that box* only if the owner turned on
      **Confirm finds over MeshCom** (off by default). The text is fixed (`Found AC-1234 logged ✓ tier C`),
      short, and rate-limited per destination.
5. **Node registry.** The listener reports its configured nodes (`ip`, `call`) in its periodic stats; the
   gateway keeps the last report per box so the UI knows which boxes can send MeshCom and under which call.
6. **Outcomes.** The UI shows *queued → handed to node / refused (reason)*. A back-pressure notice from the
   node (`QRS`, `QRT NOT SENT`) arriving on the listener within a minute is attached to the command as
   *node refused*. Nothing is ever shown as *delivered*.

## Why not the outbox

Queuing MeshCom messages in `aprs_outbox` with `target = 'meshcom'` would let any feature on the instance make
any box with the secret transmit under that box's node call — the node owner would not have authorised the
individual message. It would also route to "a" box rather than the box whose node heard the conversation.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Build the `box_commands` poller on the box (also completing Remote box), or a MeshCom-only endpoint? | The general poller — one channel for every owner→box command. |
| 2 | Find confirmations over MeshCom? | Off by default; the node owner opts in. |
| 3 | Confirmation text? | Fixed, not editable. |
| 4 | Rate limits? | Both: the box's token bucket (1/min, burst 3) and, on the gateway, at most one confirmation per destination per 10 minutes. |
| 5 | Remote box docs? | The poller is built next, which makes the documented Remote box surface work. |

## Tests the implementation needs

- The gateway refuses `meshcom_msg` from a non-owner, for an unverified call, or for a call that doesn't match a
  reported node.
- The box refuses when `MeshcomSender` is disabled, for group/`*` destinations, and over the rate limit, and
  acks the reason.
- End-to-end: enqueue → poll → a UDP datagram reaches a fake node on loopback → ack `handed-to-node`.
- A back-pressure notice after a send marks the command *node refused*.
