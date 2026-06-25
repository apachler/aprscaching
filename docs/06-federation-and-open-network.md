# Open-source & the federated APRScaching network — proposal

**Goal.** Open the source so any ham or club can self-host, *and* make them want to plug into
**one shared network** rather than spin up isolated islands. The model to copy is **iNaturalist**
(a shared commons whose data gets *better* the more people contribute), not a walled social app —
with **Mastodon/Diaspora-style federation** so no single server owns the network.

The failure mode to avoid: open-sourcing yields ten incompatible standalone "aprscaching clones"
that each start empty. We prevent that by making *joining strictly better than forking the network*.

---

## 1. The unfair advantage: the callsign is already a global identity

Mastodon had to invent `@user@instance`. We don't. A **callsign is globally unique, externally
verifiable** (licensing DBs, LoTW/QRZ), and we already prove control of it (the async
callsign-control badge in `callsign.ts`). So federation here is *easier* than in the fediverse:

- Identity is the callsign — the same on every instance. No instance-scoped handles.
- Verify **once**, be recognized **everywhere**: turn the badge into a **portable signed
  attestation** (callsign ↔ public key, signed by the verifying instance / a community key).
- The data we federate (caches, finds, positions) is **objective and corroborable**, unlike
  social posts — which is exactly why an iNaturalist-style *quality-improving commons* fits.

---

## 2. Shape: a data commons, not a social network

Three shared, federated datasets — everything else is local UX:

| Commons | What | iNaturalist analogue |
|---|---|---|
| **Cache registry** | the global, deduplicated catalog of caches (native + imported OC/SOTA/POTA) | the species/observation catalog |
| **Find ledger** | signed, presence-verified find logs | observations |
| **Corroboration pool** | independent RF receptions (who heard whom, via which IGate) | community identifications that raise data to "research-grade" |

A solo fork starts with an empty map and weak verification. Join the network and you instantly
get a global catalog, a portable verified identity, and **stronger** verification (§4).

---

## 3. Architecture: federated instances + signed records

```
   ┌─ instance A (oe.aprscaching.org) ─┐        ┌─ instance B (club-xyz.example) ─┐
   │ Worker/Node + D1/SQLite + ingest  │◄──────►│ Worker/Node + SQLite + ingest    │
   │ /.well-known/aprscaching          │  sync  │ /.well-known/aprscaching         │
   │ /federation/{caches,finds}?since= │ (pull  │ peers: [A, C, …]                 │
   │ pubkey, regions, peers            │ +relay)│                                  │
   └───────────────────────────────────┘        └──────────────────────────────────┘
            ▲ APRS-IS (already a global real-time bus for positions)  ▲
```

- **Records are signed.** A cache definition and a find log are JSON records signed by the
  author's callsign key. Signature + callsign = portable, tamper-evident provenance. Any instance
  can verify the *claim* cryptographically and (if it has the data) re-check the *presence*.
- **Sync.** Each instance pulls `/federation/finds?since=<cursor>` from peers it follows and
  mirrors them; a lightweight firehose/relay pushes new records in near-real-time. (Positions keep
  flowing over APRS-IS as today — we don't reinvent that bus.)
- **Discovery.** `/.well-known/aprscaching` advertises the instance's pubkey, regions covered, and
  peer list; a community **instance directory** lets new nodes bootstrap from the global seed.
- **Global IDs / namespacing.** `AC-1234` collides across instances, so identities and caches get
  namespaced IDs — `did:call:OE8APR` for people, `cache:<instance>:<code>` for caches; imported
  caches dedupe on their canonical external IDs (OC code / SOTA / POTA ref). A neutral registry
  assigns instance prefixes — hams already know this pattern (tocall/tactical-call registration).

**Protocol vs transport recommendation.** Build a *purpose-built* federation protocol for the
registry + verification (ActivityPub can't express geo-dedup or corroboration), but expose an
**optional ActivityPub bridge** so finds can appear in the fediverse and reuse existing relays.
Core = our protocol; AP = a social *outlet*, not the backbone.

---

## 4. The network-effect feature: cross-instance verification

This is the centerpiece — the reason to join, not fork. Today `verify.ts` checks the *local*
instance's stored positions. A find reaches **Tier A** only if this instance happened to store an
RF-heard, independently-gated fix. In a network:

> When verifying a find, an instance also asks its **peers' corroboration pools** for independent
> RF receptions of the logger near that place/time, gated by an IGate the logger doesn't control —
> ideally on a *different* instance.

So **more instances and more IGates ⇒ more finds reach Tier A.** Verification quality scales with
participation, exactly like iNaturalist's "needs-ID → research-grade." Corollaries:

- Running an IGate now helps *everyone's* verification → gamify it: a **"corroborator" reputation**
  and badges for operators whose IGates corroborate others' finds. This also grows real APRS-IS/RF
  coverage — a public good for the whole hobby.
- A standalone island throws away all peer corroboration. The network is simply better radio.

---

## 5. Features we can build on this backend

1. **Federated geofence prompts** — "you're near a cache" works across all instances' caches.
2. **Network-wide leaderboards, FTF races, badges** — compete globally, identity travels.
3. **Corroborator reputation** — credit for running IGates that verify others (see §4).
4. **Cache replication & adoption** — caches survive an instance going offline (mirrored to peers);
   maintainership can be adopted, so the catalog is resilient.
5. **Cross-region quests** — grid-square bingo, summit-to-summit, POTA rover challenges spanning
   instances.
6. **Open data commons (the GBIF analogue)** — an openly-licensed export of caches + *consented,
   anonymized* find stats for propagation studies, activity heatmaps, and third-party apps.
7. **ActivityPub bridge** — opt-in cross-posting of finds to the fediverse: reach without becoming
   a social network.
8. **Trust webs & moderation** — instances pick peers (allow/deny), share spoof reports; callsign
   reputation is portable.
9. **Mesh / off-grid federation** — instances sync opportunistically over Meshtastic/packet where
   there's no internet. Deeply on-brand for ham radio.
10. **"Bring your club"** — a club self-hosts its region, owns its data, still participates globally.

---

## 6. Make self-hosting trivial (or forks win by accident)

Today the gateway is Cloudflare-locked (Workers/D1/Durable Objects). For broad OSS adoption, ship a
**portable runtime**: `packages/aprs`, `packages/shared` and `verify.ts` are already pure TS — add a
**Node/Bun adapter** (e.g. Hono) backed by **SQLite (libSQL)** in place of D1 and a plain WS server
in place of the DO, behind the *same* HTTP/WS API. Then self-host = `docker run` on a Pi or VPS, and
the Cloudflare deploy stays a first-class option (the reference instance). Low friction to host = more
nodes = a bigger network.

---

## 7. Governance & licensing (the anti-fragmentation levers)

- **Protocol-first + a conformance suite.** Forking the *code* is fine; the conformance tests keep a
  fork *on the network*. Like email/XMPP/ActivityPub: many servers, one network.
- **License split (proposal):** **AGPLv3** for the server (SaaS improvements stay open) + **Apache-2.0**
  for the protocol spec and client/parser libs (maximize reuse). Copyleft on the server nudges
  contributors to upstream rather than run closed forks.
- **Neutral spec + working group**, a public **instance directory**, and a community **prefix/tocall
  registry**. OE8APR runs the **reference instance** as the bootstrap seed so new nodes are never empty.
- **Privacy guardrails.** Corroboration uses position data — define retention, consent, and what
  leaves an instance (hashes/evidence, not raw tracks where avoidable).

---

## 8. Phased rollout (extends the milestone list)

| Phase | Deliverable | Builds on |
|---|---|---|
| **F0** | Portable signed **callsign attestation** (badge → verifiable credential) | `callsign.ts`, passkeys |
| **F1** | **Sign** cache + find records; read-only `/.well-known` + `/federation/*` mirror endpoints | D1 records |
| **F2** | **Pull-sync + instance directory**, namespaced global IDs, global aggregated map | F1 |
| **F3** | **Cross-instance verification** + corroborator reputation | `verify.ts`, F2 |
| **F4** | Open-data export, **ActivityPub bridge**, mesh/off-grid sync | F2–F3 |

F0–F1 can begin right after M2 (the verification engine is the thing we federate). Portability (§6)
should land early — it's the single biggest lever on how many people actually join.

---

## 9. Decisions to steer

1. **License** — AGPLv3 server + Apache-2.0 protocol/libs, or fully permissive for max adoption?
2. **Namespace authority** — who assigns instance prefixes (a registry repo? a tocall-style body)?
3. **Federation default** — open pull (anyone can mirror) or peer-approved (allowlist)?
4. **Position privacy** — what corroboration evidence may cross instances, and for how long?
5. **Reference runtime** — commit to the Node/SQLite self-host target now (recommended), or stay
   Cloudflare-only for v1 and portability later?

**Resolved (see `docs/14-open-decisions.md`):** (1) **License decided** — AGPL-3.0-or-later for the
app/gateway, MIT for `packages/*` libs, CC-BY-SA-4.0 for docs (`LICENSE` files in repo). (5)
**Reference runtime committed** — Node/SQLite self-host is implemented and CI-proven alongside
Cloudflare. **Federated deletes (ADR-5):** account/find deletion emits an Ed25519-**signed tombstone**
served at `GET /federation/tombstones`; peers verify it and purge mirrored copies on sync, so GDPR
deletes propagate. Tombstones carry only signed global ids + timestamp (no PII). New `tombstones`
table + a federation migration; full spec in `docs/14`.

**Next level (F4–F7).** The roadmap that takes this beyond F0–F3 — peer **trust tiers + quarantine**
and corroboration **quorum** (resolving #2/#3/#4 above), gossip push-to-pull, a generalized signed-feed
envelope, a federated catalog in the read API/map, account-move records, owner field redaction, and key
rotation / instance registry / observability — is specced in **`docs/15-federation-next.md`**. F4 (trust)
is launch-gating before federation is opened to untrusted peers.
