# Logging finds over radio messages (design)

!!! note "Agreed design"
    Nothing on this page is built. It is the agreed design for logging a find — or a DNF or note — by sending
    a text message from a radio instead of tapping **Log a find** in the app. It replaces the separate
    MeshCom-transmit proposal: APRS and MeshCom share one engine, and only the reply path differs.

## Goal

A player without a smartphone, or with no mobile data at the cache, sends a short message from their radio:

```
FOUND AC-1234 nice spot, TFTC
```

The instance logs the find to the account that holds the sending callsign, scores it with the normal
verification engine, and acknowledges the message.

## One engine, every transport

Every text message the gateway ingests already arrives as an APRS message packet
(`kind: "message"`, addressee, text, message number), whatever carried it:

| Transport | How it reaches the gateway |
|---|---|
| APRS over RF | the ingest box's KISS / AGWPE / host-mode TNC |
| APRS-IS | the ingest box's APRS-IS feed |
| MeshCom | the MeshCom listener maps a direct message to an APRS message |

So the command handler lives once in the gateway ingest path, beside the existing messages log: a message
whose addressee is the instance's **service call** is a command. The transport never decides whether a
command runs — it only decides how far the message is trusted (its provenance) and which way the ack goes.

Meshtastic is out of scope: its nodes are identified by node ids, not callsigns, so a message cannot be tied
to a verified callsign.

The service call is the identity the gateway already sends from for callsign-verification codes and BBS
forwarding: `BBS_CALL`, default `APRSCG`.

## Commands

| Command | Effect |
|---|---|
| `FOUND <code> [text]` | log a find, with optional log text |
| `DNF <code> [text]` | log a did-not-find |
| `NOTE <code> <text>` | log a note |
| `HELP` | the command syntax |

Commands are case-insensitive; `<code>` is a cache code such as `AC-1234` (the dash is optional). The APRS
message text limit (67 characters) and the MeshCom limit (150 bytes) bound the log text; longer logs are
written in the app.

## Who the log belongs to

The log is attributed to the **account** that holds the sender's base call, and only when that callsign is
control-verified. The bare call string never authors a log. A message from an unknown or unverified callsign
is acknowledged (so the sender's radio stops retrying) and recorded as rejected, with the reason.

## Trust: heard on RF vs. arrived over the internet

Anyone can put any source callsign on a message injected into APRS-IS or relayed over the internet. The
message is therefore trusted by where it was heard, using the same provenance rules as Tier A:

- **Heard directly at an attested RF site** (the receiving site is in `FIRST_PARTY_SITES`): the log is written
  immediately.
- **Arrived only over the internet** (APRS-IS, a MeshCom relay, a tunnel): the log is recorded as
  **pending**. It appears in the player's app under *Logs sent over the air* and becomes a real log only when
  the signed-in player confirms it with one tap. Unconfirmed requests expire after 7 days.

This decides only whether the message is **accepted as the player's own**. The find's verification tier is
scored separately and exactly as for an app log, at the time the message was sent:

- **Tier A** when the player's position beacons near the cache were heard at an attested site through an
  IGate that is not their own, within the verification window before the message.
- **Tier C** otherwise. A radio message carries no in-app device reading, so it never reaches Tier B.

## Acknowledgements and replies

| | APRS | MeshCom |
|---|---|---|
| **Protocol ack** (always) | `:SENDER   :ack<msgNo>` from the service call, queued in the APRS outbox; the ingest box's APRS-IS uplink publishes it, and an IGate near the player gates it to RF | sent by the MeshCom node whose listener heard the message, as a `meshcom_msg` box command to that node owner's box; it goes out only when that box has MeshCom transmit enabled |
| **Text reply** (opt-in) | a fixed text such as `AC-1234 found, logged Tier A` or the reason it was not logged; the instance operator turns it on | the same fixed text; the node owner turns on **Confirm finds over MeshCom** |

Replies are fixed texts, never user-editable, and rate-limited: at most one reply per destination per
10 minutes on the gateway, plus the box's own transmit rate limit for MeshCom.

A MeshCom node transmits every message under its own callsign, so anything sent over MeshCom — ack or
reply — goes through the node owner's box command channel, never through the instance-wide outbox. The
gateway picks the box from the node registry (each box reports the MeshCom nodes it listens to) and gates the
command like every transmit command: a verified callsign held by the box owner, equal to the node's call.

## Duplicates and abuse

- APRS senders retry an unacknowledged message with the same message number: a command is keyed by
  (sender, message number) and runs once; a retry is only re-acknowledged.
- MeshCom frames are already de-duplicated by frame id before they reach the gateway.
- A sender may run at most 10 commands per hour; beyond that commands are acknowledged and rejected.
- One found log per player per cache, as in the app: a second `FOUND` for the same cache is acknowledged
  and answered (if replies are on) with *already logged*.

## Data

A table `radio_commands` records every command: sender, account (when resolved), command, cache,
log text, transport, whether it was heard at an attested site, message number, status
(`logged` · `pending` · `rejected` · `expired`), reason, the resulting log id, and timestamps. It belongs to
the player's data: the GDPR export includes it and erase deletes it.

## Open points

- **HELP with replies off.** `HELP` only makes sense with a reply. Proposal: a `HELP` reply is sent even when
  text replies are off, because the sender explicitly asked for it; it is still rate-limited.
- **MeshCom addressee.** `APRSCG` contains no digit. The MeshCom firmware must be checked for whether it
  carries a direct message to such an address; if not, MeshCom users address the instance's licensed
  service call (`FED_APRS_CALL`) instead.
- **MeshCom ack format.** The acknowledgement a MeshCom node expects for a numbered direct message must be
  confirmed against the firmware before the MeshCom ack is built.

## Build order

1. Gateway: the pure command parser, the handler in the ingest path, `radio_commands`, APRS acks via the
   outbox, pending confirmation in the app, export/erase.
2. APRS text replies (operator opt-in).
3. MeshCom: node registry, `meshcom_msg` box command, ack and opt-in reply through the owner's box.

## Tests the implementation needs

- The parser accepts every command form and rejects malformed ones with a reason.
- A message heard at an attested site logs immediately; the same message over APRS-IS is pending; confirming
  it in the app creates the log with the tier scored at message time.
- A retry with the same message number is re-acked but logged once.
- An unverified or unknown callsign is acked and rejected; a callsign held by another account never logs
  for this one.
- Tier A with an independent attested IGate and a nearby beacon; Tier C without.
- The APRS ack is queued from the service call with the sender's message number.
- MeshCom: the ack is queued only to the box that owns the hearing node, and refused when that box has
  MeshCom transmit disabled.
