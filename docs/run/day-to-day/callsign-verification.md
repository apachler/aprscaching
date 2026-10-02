# Callsign verification

Users verify their own calls under **Settings → Account → verify**, choosing a method. Every verification
records its method (`callsign_verifications.method`) and who vouched (`verified_by`):

| Method | How | `verified_by` | Needs on this instance |
|---|---|---|---|
| `rf_heard` | `VERIFY <code>` sent to the service call, heard by a site in `FIRST_PARTY_SITES` on its own TNC, or by its MeshCom node directly over LoRa | the receiving site | attested sites |
| `ampr_dns` | a code in `_aprscaching.<call>.ampr.org` TXT: a DNSSEC-validated answer over `DOH_URL`, or else the same TXT set from every resolver of `AMPR_DNS_RESOLVERS` that answers (at least 2) | `<call>.ampr.org` | outbound HTTPS to the resolvers |
| `lotw` | a challenge signed with the user's LoTW callsign certificate, which must chain to a CA in `LOTW_CA_PEM` and name the call | the trusted CA's name | `LOTW_CA_PEM` |
| `operator` | the operator CLI with the operator secret, for an `ADMIN_CALLSIGNS` call | `operator` | — |
| `sysop` | by hand, below | the sysop's call | — |

On the air, a copy over APRS-IS, AXUDP/AXIP, the MeshCom server, a mesh relay or a signed browser batch
never counts. Without attested sites nobody can verify that way.

`callsign_verifications` is the one record of a verification: the session, the held-call list, device
keys, transmitting and the sysop role all read it, so a revocation takes effect everywhere at once. A
verification covers the base call and every SSID of it. Claiming a call nobody held starts it unverified —
whatever was recorded for it before was for someone else — so verify a call (including your own operator
call with the CLI) after its holder has signed up.

The `ampr_dns` method accepts one of two proofs, and stores which one held in the verification's `note`:

| Proof | `note` | Strength |
|---|---|---|
| DNSSEC | `dnssec` | `DOH_URL` validated the answer from the root (AD flag). Cryptographic: forging it means breaking the zone's signatures. |
| Independent resolvers | `<n> resolvers: <hosts>` | Without AD, every resolver of `AMPR_DNS_RESOLVERS` (default Cloudflare, Google, Quad9) is asked; at least 2 must answer, and every one that answers must return NOERROR with the same TXT set carrying the code. Forging it means poisoning several large, separately run resolver caches at the same moment, or the path from them to ARDC's name servers. |

A resolver that times out or fails at the HTTP level has not answered and does not block the others; a DNS
error or a different TXT set from any resolver refuses. An answer through a CNAME or DNAME is refused
either way, so a proof never leaves the ampr.org zone. A name that does not exist yet costs the user no
attempt: the ARDC portal publishes the zone periodically, and users check again until it does.

While ampr.org is not DNSSEC-signed (the `org` zone publishes no DS record for it), verifications use the
resolver proof. Once ARDC signs the zone, `DOH_URL` returns AD and new verifications use DNSSEC without any
change here. `AMPR_REQUIRE_DNSSEC=1` accepts only the DNSSEC proof: while the zone is unsigned every check is
then refused with that reason, and users pick another method. To re-check or revoke the weaker ones later,
list them:

```sql
SELECT callsign, verified_at, note FROM callsign_verifications
 WHERE status = 'verified' AND method = 'ampr_dns' AND note <> 'dnssec';
```

## LoTW callsign certificates

No ARRL certificate ships with the gateway, so the `lotw` method stays off until you set `LOTW_CA_PEM` to the
LoTW CA certificate(s) you trust — normally ARRL's *Logbook of the World Root CA*. Trusting the root is
enough: TQSL writes the whole chain (callsign certificate, production CA, root) into every `.p12` it saves,
and the browser sends that chain along. As a LoTW user you can take the CA certificates from your own file:

```
openssl pkcs12 -in my-call.p12 -cacerts -nokeys -out lotw-ca.pem   # add -legacy for an older-format file
openssl x509 -in lotw-ca.pem -noout -subject -dates -fingerprint -sha256
```

Keep only the root's block, and compare its SHA-256 fingerprint with a second independent copy — another
ham's TQSL file, or ARRL — before you trust it. The gateway then checks each callsign certificate's
signature chain, that it is valid now and each CA was valid when it issued the certificate below it, that
its subject attribute `AROcallsign` (OID `1.3.6.1.4.1.12348.1.1`) is exactly the base call, and the user's
signature over the challenge. It does not consult LoTW's certificate revocation service.

For an operator out of range of every attested site, a sysop verifies the call by hand under **Instance
admin → Callsign verification**: the callsign, and a required note saying how control of the licence was
checked. The call is verified with method `sysop`, recording the sysop's call and the time; the list shows
every manual verification, and **Revoke** returns a call to unverified. Revoking touches only manual
verifications — a call verified on the air or by the operator CLI is neither listed nor revocable there.
Both actions are logged in `account_events`.

## Next

- [Cache adoption](cache-adoption.md).
