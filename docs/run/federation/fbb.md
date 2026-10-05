# Federation over FBB

This page is for the [sysop](../../glossary.md#sysop) of an instance that has no internet, 44Net or HAMNET path to
a peer, but does forward packet mail with a partner BBS. It shows how to carry federation records as
[FBB](../../glossary.md#fbb) mail to that partner. At the end the partner's instance applies your records, late,
and yours applies its records.

!!! warning "Experimental"
    Federation over FBB is off by default and untested on real BBS networks. Use it only with partners whose
    sysops have agreed to it, and expect to report what you find.

## What it is for

Federation over FBB is delay-tolerant delivery: the last way records reach a peer when no direct path exists.
A batch of signed records travels as one personal message, BBS to BBS, on the forwarding schedule you already
run. The records are the same signed frames the internet path carries, so the receiving instance checks every
signature against the keys it holds for the origin, exactly as it does for a pulled feed. The mail path adds no
trust: a record from an instance the receiver does not know stays quarantined.

It is not a replacement for internet federation. Use [Join the network](index.md) wherever a direct path
exists.

## How it behaves

- **Off by default.** With `FED_BBS` unset or `0`, nothing is queued for FBB and the instance drops any
  federation message that arrives by FBB, unapplied.
- **Partners only.** A batch goes only to a forwarding partner you mark for federation. The forward rules never
  route it, so it never goes to a partner you did not mark. A batch that arrives from a partner you did not
  mark is dropped, unapplied.
- **Never flooded.** A batch travels as a personal message to `ACSFED` at the partner's BBS. A BBS delivers
  personal mail to its addressee; it does not pass it on to its own partners the way it floods a bulletin.
- **Slow.** A batch moves when the forwarding schedule next connects, then waits at the far end for the next
  exchange. Expect hours to days, not minutes.
- **No recall.** A batch already forwarded cannot be called back. A deletion travels as a signed
  [tombstone](../../glossary.md#tombstone) in a later batch, the same way and as late; until it arrives the
  partner still shows the record.
- **Kept 30 days.** A batch waiting for a partner expires after 30 days, like a bulletin. The same content is
  queued once: a second request for an unchanged batch adds nothing.

## Etiquette

- **Ask first.** Ask each partner BBS's sysop before you mark the partner. A batch is machine data that uses
  their link and their storage, and some BBSes refuse mail they did not agree to carry.
- **Keep batches small.** At 1200 baud a batch of a few hundred records takes minutes of airtime. Send what
  changed since the last batch (`since`), and a small `limit`.
- **Mind the rules.** The body is base64, an encoding anyone can read, never ciphertext. You remain the
  control operator of a station that forwards on its own
  ([Automatic stations on the air](../compliance/on-air-stations.md)).

## Before you start

- FBB forwarding running with the partner: `BBS_FORWARD=1` on your ingest box, the partner set under
  **Instance admin → FBB forwarding** ([Packet: BBS & NET/ROM node](../radios/packet-node.md#fbb-forwarding)).
- A signing key in `FED_PRIVATE_KEY` ([Sign your feeds](index.md#sign-your-feeds)).
- The partner instance as a peer you trust, with its key fingerprint compared
  ([Peers and trust](index.md#peers-and-trust)). Without its key, your instance quarantines its records.
- The partner sysop's agreement. Both instances run the steps below.

## Steps

1. Set `FED_BBS=1` in the gateway's settings and restart the gateway.
2. Open **Instance admin → FBB forwarding**. Each partner now shows a **Federation (experimental)** switch.
3. Turn on the switch of the partner whose sysop agreed, and confirm. The other partners stay off.
4. Queue a batch from a script on the gateway's host, with the operator secret:

    ```bash
    curl -sS -X POST "$APP_URL/federation/bbs/enqueue" \
      -H "x-operator-secret: $OPERATOR_SECRET" -H 'content-type: application/json' \
      -d '{"since": 0, "limit": 50}'
    ```

    The answer names the batch's BID, the number of records in it, and a `cursors` value per feed. Pass the
    oldest cursor as `since` next time. Nothing queues a batch on its own: run this when you want one sent, or
    from your own timer.

A hub dispatches a packet-only spoke's [relay](hubs-and-relays.md#rendezvous-relay) queries the same way, with
`POST /federation/relay/<instance>/dispatch` ([API reference](../../reference/api.md)), and the spoke answers
over FBB on its own. Both need `FED_BBS` on, on both instances.

## Check that it worked

- **Instance admin → Setup** shows **Federation over FBB (experimental)**: off, or on with the number of partners
  marked for it. `deploy/aprscaching doctor` reports the same as `federation.fbb`.
- After the partner's next forwarding session, your caches show on the partner instance's map.

## Next

- [Federation wire format](../../reference/federation-wire.md#store-and-forward-over-fbb): the batch format and
  how a batch is addressed.
- [Packet: BBS & NET/ROM node](../radios/packet-node.md): set up FBB forwarding.
