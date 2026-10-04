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
| `ampr_dns` | a code in the `_aprscaching.<call>.ampr.org` TXT record: a DNSSEC-validated answer over `DOH_URL`, or else the same TXT set from every resolver of `AMPR_DNS_RESOLVERS` that answers (at least 2) | `<call>.ampr.org` | outbound HTTPS to the resolvers |
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

The `ampr_dns` method accepts one of two proofs, and stores which one held in the verification's `note`:

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

## Verify a call by hand

For an operator out of range of every attested site, a sysop verifies the call under **Instance admin →
Callsign verification**.

1. Enter the callsign, and a required note saying how you checked control of the licence.
2. Select **Verify callsign**. The call is verified with method `sysop`, recording your call and the time.

The list shows every manual verification, and **Revoke** returns a call to unverified. Revoking touches only
manual verifications: a call verified on the air or by the operator CLI is neither listed nor revocable there.
Both actions are logged in `account_events`.

## Next

- [Cache adoption](cache-adoption.md): hand over caches, which needs a verified call.
- [The trust model](../../reference/trust-model.md): the find tiers, which are separate from callsign
  verification.
