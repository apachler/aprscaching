# Cache adoption

A cache whose owner erased their account is archived and owned by a withdrawn marker, so nobody can edit it;
a cache whose owner stopped looking after it has the same problem while the owner still exists. **Instance
admin → Cache adoption** hands such caches to new owners.

- **Offer for adoption** — by cache code, or with **Offer…** on a cache under **Withdrawn owners**, with a
  required note saying why. The note is public: the cache appears in the **Up for adoption** list and on its
  own page. Only caches hidden on this instance can be offered; imported caches cannot.
- **An active owner is told and can refuse.** Offering a cache whose owner still has an account puts an alert
  in the owner's list (and a push, where configured) and shows the offer on the cache page, where **Keep my
  cache** ends it. Such a cache cannot change hands until the offer has stood for **14 days**; a withdrawn
  owner has nobody to tell, so there is no wait.
- **Requests, then approval.** A signed-in user whose call is control-verified asks for an offered cache from
  its page, saying whether they have checked that the container is in place. Requests wait for a sysop:
  first come would let the quickest account grab any cache, and a person can check who is asking. **Approve**
  hands the cache over and declines the other requests; **Decline** tells the requester.
- **Assign…** hands a cache straight to a call: the call must be held by an account and control-verified
  (verify it by hand first if needed), and a note is required. Tick **the container is confirmed in place**
  to make the cache active again.
- **Withdraw offer** ends an offer and cancels its pending requests.

A hand-over changes only the owner — and the status, to active, when the container is confirmed in place;
otherwise the cache keeps its status until the new owner edits it. Finds, logs, media and history stay with
the cache. Approval re-checks that the requester's account still holds the call and that it is still
verified. The new owner reaches federation peers through the caches feed, which carries every cache change;
a local-only cache stays local and an unlisted one keeps its description back.

Every step — offer, withdrawal, owner refusal, request, cancellation, approval, decline, assignment — is kept
in `cache_adoptions` with who, when, the owner before and after, and the note; the latest are under **Recent
activity**. A person's export includes their requests and the trail rows naming them; erasure deletes their
requests and replaces their call in the trail with the withdrawn marker, dropping the notes on those rows.

## Next

- [Licence registers](licence-registers.md).
