# Callsign verification

This page is for the sysop. It explains how this instance decides that a member controls a callsign, what each
method needs from you, and how to verify or revoke a call by hand.

## How members verify

Members verify their own calls under **Settings → Account**, choosing a method
([Verify your callsign](../../play/join.md#verify-your-callsign) is their side). Every verification records its
method (`callsign_verifications.method`) and who vouched for it (`verified_by`):

| Method | How | `verified_by` | Needs on this instance |
|---|---|---|---|
| `rf_heard` | `VERIFY <code>` sent to the service call, heard by a trusted receiving station (`FIRST_PARTY_SITES`, or **Instance admin → Trusted receiving stations**, including enrolled boxes trusted there) on its own TNC, or by its MeshCom node directly over LoRa | the receiving site | attested sites |
| `ampr_dns` | a code in the `_aprscaching-verify.<call>.ampr.org` TXT record (a name of its own, apart from the [federation identity record](../networks/44net-identity.md#3-name-and-identity)): a DNSSEC-validated answer over `DOH_URL`, or else the same TXT set from every resolver of `AMPR_DNS_RESOLVERS` that answers (at least 2) | `<call>.ampr.org` | outbound HTTPS to the resolvers |
| `lotw` | a challenge signed with the member's LoTW callsign certificate, which must chain to a CA in `LOTW_CA_PEM` and name the call | the trusted CA's name | `LOTW_CA_PEM` |
| `operator` | the operator CLI with the operator secret, for an `ADMIN_CALLSIGNS` call | `operator` | — |
| `sysop` | by hand, [below](#verify-a-call-by-hand) | the sysop's call | — |

On the air, a copy over APRS-IS, AXUDP/AXIP, the MeshCom server, a mesh relay or a signed browser batch never
counts. Without attested sites nobody can verify that way.

`callsign_verifications` is the one record of a verification. The session, the held-call list, device keys,
transmitting and the sysop role all read it, so a revocation takes effect everywhere at once. A verification
covers the base call and every SSID of it.

Claiming a call nobody held starts it unverified, because whatever was recorded for it before was for someone
else. So verify a call, including your own operator call with the CLI, after its holder has signed up.

## The ampr.org DNS proofs

The member publishes the code at `_aprscaching-verify.<call>.ampr.org`, entered as `_aprscaching-verify` in the
44Net Portal; the record at `_aprscaching.<call>.ampr.org`, the instance's federation identity, is never read for
it. The `ampr_dns` method accepts one of two proofs, and stores which one held in the verification's `note`:

| Proof | `note` | Strength |
|---|---|---|
| DNSSEC | `dnssec` | `DOH_URL` validated the answer from the root (AD flag). Cryptographic: forging it means breaking the zone's signatures. |
| Independent resolvers | `<n> resolvers: <hosts>` | Without AD, every resolver of `AMPR_DNS_RESOLVERS` (default Cloudflare, Google, Quad9) is asked; at least 2 must answer, and every one that answers must return NOERROR with the same TXT set carrying the code. Forging it means poisoning several large, separately run resolver caches at the same moment, or the path from them to ARDC's name servers. |

A resolver that times out or fails at the HTTP level has not answered and does not block the others. A DNS
error or a different TXT set from any resolver refuses. An answer through a CNAME or DNAME is refused either
way, so a proof never leaves the ampr.org zone. A name that does not exist yet costs the member no attempt: the
ARDC portal publishes the zone periodically, and members check again until it does.

While ampr.org is not DNSSEC-signed (the `org` zone publishes no DS record for it), verifications use the
resolver proof. Once ARDC signs the zone, `DOH_URL` returns AD and new verifications use DNSSEC with no change
here. `AMPR_REQUIRE_DNSSEC=1` accepts only the DNSSEC proof: while the zone is unsigned every check is then
refused with that reason, and members pick another method.

To re-check or revoke the weaker ones later, list them with this query on the database:

```sql
SELECT callsign, verified_at, note FROM callsign_verifications
 WHERE status = 'verified' AND method = 'ampr_dns' AND note <> 'dnssec';
```

## LoTW callsign certificates

No ARRL certificate ships with the gateway, so the `lotw` method stays off until you set `LOTW_CA_PEM` to the
LoTW CA certificates you trust, normally ARRL's *Logbook of the World Root CA*. Trusting the root is enough:
TQSL writes the whole chain (callsign certificate, production CA, root) into every `.p12` it saves, and the
browser sends that chain along.

1. As a LoTW user, take the CA certificates from your own file:

    ```bash
    openssl pkcs12 -in my-call.p12 -cacerts -nokeys -out lotw-ca.pem   # add -legacy for an older-format file
    openssl x509 -in lotw-ca.pem -noout -subject -dates -fingerprint -sha256
    ```

2. Keep only the root's block.
3. Compare its SHA-256 fingerprint with a second independent copy, another ham's TQSL file or ARRL's, before
   you trust it.
4. Set `LOTW_CA_PEM` to it and restart the instance.

The gateway then checks each callsign certificate's signature chain; that it is valid now and each CA was valid
when it issued the certificate below it; that its subject attribute `AROcallsign`
(OID `1.3.6.1.4.1.12348.1.1`) is exactly the base call; and the member's signature over the challenge. It does
not consult LoTW's certificate revocation service.

## Look a call up

Open **Instance admin → Callsigns**, type the callsign and select **Look up**. The card shows:

- who holds the call: the account (its id, abbreviated), its active call, every call it holds, its passkeys
  and whether it has an email;
- how the call is verified, by whom and when, or **unverified**;
- open claims on the call, and its holder changes: every claim and release.

Both actions below act on the account the card shows. If another account took the call meanwhile, the gateway
refuses with `confirm_holder` and you look it up again.

## Verify a call by hand

For an operator out of range of every attested site:

1. Look the call up, and check that the account the card shows is the licensee's.
2. Type how you checked control of the licence, and select **Verify by hand**.
3. Confirm. The call is verified with method `sysop` for that account, recording your call and the time.

**Verified by hand** lists every manual verification, and **Revoke** returns a call to unverified. What the
call had queued for APRS-IS or for an ingest box to transmit is deleted with it, and the queues serve only calls
that are still verified. Revoking touches only manual verifications: a call verified on the air or by the operator CLI is neither listed nor
revocable there. Both actions are logged in `account_events`.

## Claims: a licensee takes a call over

Holding a call is not proof of the licence. While the account holding a call has not proven control, the
licensee can open a claim and complete any method above for the call. The call then moves to the licensee,
verified, and the claim shows in the call's holder changes. Nothing waits for you.

A claim never displaces a verified holder, and never takes a held `ADMIN_CALLSIGNS` call. An `ADMIN_CALLSIGNS`
call nobody holds is registered only through your sign-in link or by a claim, never by an unproven sign-up.
Nor does a claim take a call while its holder's account is suspended: the claimant is told to ask you, and
**Release** below still frees it.

Each claim gets its own on-air codes: five an hour per claim, and twenty an hour per client address across
its claims. Two claimants on one call never use up each other's codes.

The account that loses a call keeps its other calls. What it wrote in the app under the call (caches, logs,
ratings, favourites, watches, badges, saved views) stays on that account and shows under its remaining call,
or as `FORMER` when it holds no other. Every device key, station and weather key on the call is removed, on
whichever account it is listed, including a station you listed on the call for another member. Messages still
queued for APRS-IS under the call, or carried for it by the service call's Mailbox, are dropped. The federation
learns of it from signed tombstones for those keys and the moved finds, and from the caches served again.
Positions, stations and messages the radio sent stay with the call.

An account left with no call can still export or erase its data: an email link to its confirmed address opens
a session that does only that ([Your data](../../play/account.md#your-data)). The notice mail says how.

## Release a call from an account

When a verified holder does not hold the licence, or a member asks to drop a call:

1. Look the call up.
2. Type the reason, select **Release** and confirm.

The call leaves the account the card shows, and nobody holds it until someone signs up with it or claims it.
The account keeps its other calls and its content, as for a claim, and is told why in the app and by email if
it has one. The release, with your call and the reason, is recorded in `callsign_events`.

## Next

- [Cache adoption](cache-adoption.md): hand over caches, which needs a verified call.
- [The trust model](../../reference/trust-model.md): the find tiers, which are separate from callsign
  verification.
