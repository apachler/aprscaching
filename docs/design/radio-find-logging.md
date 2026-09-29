# Logging finds over radio messages (design)

!!! note "Built and planned"
    Logging a find — or a DNF or note — by sending a text message from a radio instead of tapping **Log a
    find** in the app. APRS and MeshCom share one engine, and only the reply path differs. Built: the command
    engine in the gateway ingest path (`workers/gateway/src/radiolog.ts`), `radio_commands`, acks and
    opt-in replies sent back the way each message came (the hearing box's RF, its MeshCom node, or the
    APRS-IS outbox), pending confirmation under **Profile → Logs sent over the air**, and export/erase.
    Player guide:
    [Log from your radio](../guides/caching.md#log-from-your-radio).

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

- **Heard directly at an attested RF site** (the ingest box heard it on its own TNC or MeshCom node, and the
  receiving site is in `FIRST_PARTY_SITES`): the log is written immediately.
- **Sent in a batch signed by the sender's own device key** (the browser RF bridge): the signature proves
  the sender, so the log is written immediately as well.
- **Arrived only over the internet** (APRS-IS, a MeshCom relay, a tunnel): the log is recorded as
  **pending**. A message that came over APRS-IS is never taken as heard at a site, whatever its path says —
  anyone can inject a `qAR` path naming an attested site. It appears in the player's app under *Logs sent over the air* and becomes a real log only when
  the signed-in player confirms it with one tap. Unconfirmed requests expire after 7 days. If a copy of the
  same message is later heard at an attested site, the pending command is logged without the tap.

A pending find is scored when the message arrives and the score is stored with the command, so a
confirmation days later does not depend on positions that have since been pruned.

This decides only whether the message is **accepted as the player's own**. The find's verification tier is
scored separately and exactly as for an app log, at the time the message was sent:

- **Tier A** when the player's position beacons near the cache were heard directly by an attested site that
  is not their own — delivered by that site's own ingest box, never an APRS-IS copy — within the
  verification window before the message.
- **Tier C** otherwise. A radio message carries no in-app device reading, so it never reaches Tier B.

## Acknowledgements and replies

Every numbered message gets a protocol ack; a text reply (a fixed text such as `AC-1234 found, logged
Tier A`, or why it was not logged) is sent only when the instance operator turns replies on
(`RADIO_REPLIES=1`). Both travel back **the way the message came**:

| The message was heard | The answer goes |
|---|---|
| on the ingest box's own radio (KISS TNC) | from that box, on RF: third-party traffic whose inner source is the service call, under the box's licensed call — `OE8APR-10>APZACG:}APRSCG>APZACG,TCPIP,OE8APR-10*::OE3PLY-7 :ack12`, the form an IGate uses to gate APRS-IS messages to RF, so the sender's radio sees the answer come from the address it messaged. No internet needed. |
| by a MeshCom node the box listens to | from that node, handed to it over ExtUDP. The ack is the text `SENDER   :ack<nnn>`: the firmware offers an external client no ack frame, but its receive path treats a text message of that form as the acknowledgement of message `nnn`, matched by number alone. The node sends it under its own call. |
| only over APRS-IS | through the APRS outbox and the ingest box's APRS-IS uplink (`APRSIS_SERVICE_CALL`); an IGate near the player gates it to RF. |

Each ingest box stamps the frames it receives on a radio it can transmit on with its `BOX_ID`, and
reports with every command poll whether it may transmit (`BOX_TX=1` and the transmit switch on), whether it
has a TNC, and which MeshCom nodes it can send through (`MESHCOM_TX=1`). The gateway answers through that
box only while it polls and can deliver; otherwise an APRS answer falls back to the outbox and a MeshCom
answer is not sent. Answers are `aprs_msg` / `meshcom_msg` box commands that only the gateway can queue —
the enqueue API refuses them — and the box applies its own gates: the operator's opt-in, the transmit
switch, the command's age, its transmit rate limit, and for RF that the inner source is the service call.

Replies are fixed texts, never user-editable, and rate-limited: at most one reply per destination per
10 minutes on the gateway, at most 200 acks and replies per hour from the service in total, plus the box's
own transmit rate limit. Every answer is a clean APRS101 message: printable ASCII only, without `|`, `~` or
`{`, at most 67 characters, to an addressee field of exactly nine characters.

## Duplicates and abuse

- APRS senders retry an unacknowledged message with the same message number: a command is keyed by
  (sender, message number, text) and runs once; a retry is only re-acknowledged. A message that reuses a
  number with different text is a new command, so it can never confirm an earlier, possibly forged, one.
- A message number is one to five letters or digits (APRS101); anything else makes the message unnumbered,
  so it is not acknowledged and its number is never echoed back.
- `ack`/`rej` messages to the service call, in either case (`ACK12` included), are acknowledgements, not
  commands.
- MeshCom frames are already de-duplicated by frame id before they reach the gateway.
- A person may run at most 10 commands per hour, counted on the base call across all SSIDs; beyond that
  a message is dropped without a record, an ack or a reply.
- One found log per player per cache, as in the app, whichever SSID or callsign on the account sends it: a
  second `FOUND` for the same cache is acknowledged and answered (if replies are on) with *already logged*.
- Confirming a pending command claims it first, so two confirmations racing each other log it once.

## Data

A table `radio_commands` records every command: sender, account (when resolved), command, cache,
log text, transport, whether it was heard at an attested site, message number, status
(`logged` · `pending` · `confirming` · `rejected` · `help` · `discarded` · `expired`), reason, the resulting
log id, and timestamps. Decided commands are purged 30 days after the decision; the log itself stays in
`cache_logs`. It belongs to the player's data: the GDPR export includes it and erase deletes it, and the
export and erase of a callsign cover logs written under any of its SSIDs.

## Open points

`HELP` is always answered, even with text replies off — the sender asked for the reply — and it counts
against the per-destination reply limit.

Settled against the MeshCom firmware source (4.35t): no input path checks a direct message's destination
against a callsign pattern, so `APRSCG` is a valid destination; nodes relay direct messages not addressed to
them and output them on ExtUDP (unless the node operator turned on `--nopmother`); and a direct message
carries its number as a `{nnn` suffix, which reaches the gateway as the APRS message number.

- **MeshCom ack on the air.** The `SENDER   :ack<nnn>` text ack follows the firmware's receive path; it
  still needs a bench test on a real node. The node appends its own `{nnn` to it, so the sender's node may
  ack the ack back.

## Build order

1. Gateway: the pure command parser, the handler in the ingest path, `radio_commands`, APRS acks via the
   outbox, pending confirmation in the app, export/erase. Built.
2. APRS text replies (operator opt-in). Built.
3. Answers back the way the message came: RF acks from the hearing box, MeshCom acks and replies through
   the hearing node, capability reports on the box poll. Built; the MeshCom ack awaits a bench test.

## Tests the implementation needs

- The parser accepts every command form and rejects malformed ones with a reason.
- A message heard at an attested site logs immediately; the same message over APRS-IS is pending; confirming
  it in the app creates the log with the tier scored at message time.
- A retry with the same message number is re-acked but logged once.
- An unverified or unknown callsign is acked and rejected; a callsign held by another account never logs
  for this one.
- Tier A with a nearby beacon heard directly by an independent attested site; Tier C without, and Tier C
  when the only copy of that beacon arrived over APRS-IS naming the attested site.
- The APRS ack is queued from the service call with the sender's message number.
- MeshCom: the ack is queued only to the box that owns the hearing node, and refused when that box has
  MeshCom transmit disabled.
