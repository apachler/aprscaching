# Sustainability — Supporter Donations

aprscaching.com is funded by **voluntary supporter donations** that keep three things running:
**development, hosting, and operation** — plus a transparent pool to **reimburse the hosting/
operation costs of people who run a network peer**. This is **gift support, not a product**: there
is nothing to buy, and **no feature is ever paywalled.**

**aprscaching is open source, hosted on GitHub.** Funded work is public — which keeps the
community's trust *and* unlocks grant funding (ARDC, §3a) that requires open access.

> **Not legal/financial/tax advice.** How donations (and "donations with rewards") are taxed varies
> by jurisdiction; some platforms treat memberships as sales. Verify with an accountant and against
> Austrian/EU rules. Confirm current platform fees — they change.

---

## 0. The model in one line

**Everyone gets everything for free. Supporters give because they want the project to live, and get
recognition (a thank-you), never extra functionality.**

---

## 1. Guardrails

1. **Free forever, in full.** Every feature — caching, map, verification, workbench, API, exports —
   is free for everyone. Donations unlock **nothing functional**.
2. **Recognition, not purchase.** Supporters receive a badge / a spot on a credits page / the
   ability to hide the support nag. Keeping rewards to *recognition only* also keeps this firmly in
   donation territory rather than a taxable sale.
3. **Non-commercial RF.** Donations support the *software, hosting, and internet operation* — never
   amateur-radio transmission. Peer reimbursement covers *internet-side* hosting costs only.
4. **Ad-free.** No ads on ham data, ever. Sponsors (if any) get a thank-you credit, not ad slots.
5. **Transparent.** Publish a public ledger: what came in, and how it was spent across development,
   hosting, operation, and peer reimbursement. Hams reward openness.
6. **Respect APRS-IS.** Don't paywall or abuse the open network; run your own feeds for anything
   load-bearing.

---

## 2. Where donations go (and the public ledger)

Four transparent buckets, shown live on a `/support` ledger page:

| Bucket | Covers |
|---|---|
| **Development** | the work of building and maintaining the platform |
| **Hosting** | Cloudflare (Workers/D1/R2) + the ingest box(es) + domain |
| **Operation** | day-to-day running: monitoring, feeds, map tiles, support |
| **Peer reimbursement** | offsetting the hosting/operation costs of community peer hosts (§5) |

The ledger shows monthly totals in vs. out per bucket. No surplus targets — the goal is to keep
the lights on and reduce out-of-pocket cost, not to profit.

---

## 3. Donation platforms (donation-native first)

| Platform | Why | Recurring | EU/AT fit | Fee* |
|---|---|---|---|---|
| **Liberapay** | non-profit, donation-native, FOSS, EU | yes | **excellent** | ~processor only |
| **Ko-fi** | simple one-off + monthly, low friction | both | good | ~0% (free tier) |
| **Open Collective** | **transparent ledger + reimburse peers' costs** | both | good | host + processing |
| **GitHub Sponsors** | dev/open-source backers | both | good | 0% platform |
| **Patreon** | recurring "membership-as-support" (treat tiers as recognition) | yes | ok | ~8% + processing |
| **PayPal / Stripe (donate)** | familiar one-off donations | both | good | processor |
| **ARDC grant** | **non-dilutive** funding for open ham infrastructure | grant | — | — |

\*Verify current fees.

**Recommended:** lead with **Liberapay + Ko-fi** (low/zero fee, donation-native) and **Open
Collective** (transparency + peer reimbursement), add **GitHub Sponsors** for the dev angle, and
**apply to ARDC** — for a project like this, an ARDC grant can cover far more than small donations
and is mission-aligned. Patreon optional for those who prefer it.

---

## 3a. ARDC grant — the highest-leverage source (now unlocked)

Because aprscaching is **open source on GitHub**, it meets ARDC's open-access requirement — the
one thing that would otherwise disqualify it. **ARDC** (Amateur Radio Digital Communications) is a
US private foundation funding amateur radio + digital communications; for **2026 it aims to award
~$3.8M and funds ~30% of proposals**. Grants are **non-dilutive** (not repaid), ranging from tens
of thousands up to large awards.

**Why we fit:** ARDC's 2026 priorities include **open-source software** and **open educational
tools** that make ham radio more accessible to clubs and new operators. An open APRS workbench +
caching platform lands squarely in their goals of getting people *learning, experimenting, doing*.

**The two requirements:**
1. **Open access — satisfied.** Funded work must be public under an open licence. We're open
   source under the chosen split (below). ARDC's recommended software licences are **AGPL/GPL/MIT/
   BSD/LGPL**; for docs/media, **CC-BY-SA** (preferred), CC-BY, or CC0. **Adopted:** the hosted
   **app & gateway are AGPL-3.0-or-later** (its network-use clause keeps a *hosted* fork open — the
   right fit for a service), the **reusable libraries** (`packages/aprs`, `packages/shared`) are
   **MIT** so other ham software can embed them, and **`docs/` are CC-BY-SA-4.0**. All sit inside
   ARDC's recommended set. See the repo `LICENSE` files + the README "License" section.
2. **Eligibility — needs a nonprofit.** ARDC funds **nonprofits** (US 501(c)(3) or international
   equivalents); **for-profits and individuals are ineligible without a nonprofit fiscal sponsor.**
   As OE8APR (Austria), apply *through* an Austrian amateur-radio Verein/club (e.g. ÖVSV or a local
   club) or another fiscal sponsor.

**Process:** talk the idea through first (**giving@ardc.net**), then create an account at
**grants.ardc.net** and submit a proposal → automated acknowledgement → staff preliminary review →
Grants Advisory Committee. Allow **60–120 days**; applications batch into review windows.

### ARDC readiness checklist
- [x] Public **GitHub repo** with a clear README + OSI licences (**AGPL-3.0** app/gateway · **MIT**
      libraries · **CC-BY-SA-4.0** docs) — done; satisfies ARDC open access.
- [ ] A nonprofit **fiscal sponsor** lined up (Austrian ham club/Verein, e.g. ÖVSV, or equivalent).
- [ ] Proposal framed to ARDC priorities: **open software + open education** for clubs/new hams,
      and digital-comms experimentation (presence-verified caching, the APRS workbench).
- [ ] Budget across **development, hosting, operation** (the §2 buckets), with public deliverables
      (open code, docs, and the running platform).
- [ ] Pre-submission email to **giving@ardc.net** to confirm fit and timing.

> ARDC funds a US/international nonprofit, not you directly — the fiscal sponsor receives and
> administers the grant. Decide that relationship (and the licence) before writing the proposal.

## 4. Supporter recognition (no feature gating)

A donation grants **recognition only**:
- a **Supporter badge** (a chip next to the existing identity/trust chips),
- an opt-in line on a public **credits / supporters** page,
- the ability to **hide the "support the project" nag**.

That's the whole list. No higher limits, no locked features, no "patron-only" anything — because
it's a donation, not a purchase.

---

## 5. Peer-host cost reimbursement (help, not income)

People who host a **network peer** (an *internet-side* node — ingest/relay/tile/compute/IGate
gateway) can have their **hosting/operation costs offset** from the transparent pool. Framing
matters: this is **reimbursement to reduce their out-of-pocket cost**, not income or profit, and it
attaches to *internet infrastructure*, not amateur-radio operation.

- **Opt-in**, with a default of **recognition only** (a spot on the peers page) — many hams will
  want the credit, not the money.
- Funded by a **published share** of donations, distributed via **Open Collective** so every
  reimbursement is public.
- Eligibility/scoring is **corroborated by the network** (uptime/coverage/throughput witnessed, not
  self-reported) with per-node caps — same anti-abuse mindset as cache verification.
- Reimbursement is **capped at demonstrated cost** (you can't profit; you can be made whole).

---

## 6. Implementation (lightweight — nothing gates features)

- **Recognition flag only.** A donation (via webhook from Patreon/Stripe/Open Collective, or a
  manual confirm for Liberapay/Ko-fi) sets `accounts.tier='supporter'` purely for the **badge** and
  **hide-nag** — no feature checks anywhere read it to *restrict* anything.
- **Supporter chip + hide-nag toggle** in the UI; a **Membership/Support** group in Profile
  (grouped/collapsible per `.claude/rules/ui-ux.md`).
- **Public ledger page** (`/support`) reads the `ledger` table.
- **Peer registry + metering + public peers page**; reimbursements recorded in `payouts`
  (reimbursements) and surfaced on the ledger.
- Core handlers **never** consult entitlements. `entitlements.ts` returns recognition only.

---

## 7. Schema (migration `0012_monetization.sql`)

> Migration number pinned to **`0012`** (`docs/14`); the doc's earlier `0003` label was retrospective.
> It lands as a new migration after `0011_account_callsigns`, never renumbering existing ones.

`accounts.tier` = recognition level (free|supporter); `entitlements` holds **recognition** keys only
(badge, hide_nag) — **never functional limits** (core handlers must not read it to restrict anything,
and `api_keys` from `docs/11` are free/recognition too); `peers` + `peer_metrics` drive corroborated
eligibility; `payouts` records **cost reimbursements**; `ledger` is the public transparency record.

---

## 8. Rollout

- **Now (no code):** add Liberapay + Ko-fi (+ optional Patreon/GitHub Sponsors) links and a simple
  transparency page; **submit an ARDC grant**. Immediate.
- **M4:** Supporter badge + hide-nag via webhook/confirm; `/support` ledger page.
- **M5:** peers page (recognition) → peer **cost reimbursement** via Open Collective once there's a
  pool and a fiscal/tax wrapper.

---

## 9. Risks

- **Donation vs sale:** keep supporter rewards to *recognition only* to stay in donation territory;
  "rewards/perks" can be reclassified as taxable sales. Patreon memberships especially — verify.
- **Non-commercial RF:** reimburse internet-side hosting, not amateur operation; recognize RF
  operators rather than paying them.
- **Tax/reporting:** reimbursing individuals has reporting obligations; a fiscal host (Open
  Collective) or accountant handles it. EU VAT is largely moot for genuine donations — but confirm.
- **Community trust:** free-in-full + ad-free + public ledger. Donations are a gift to keep it
  alive, framed that way everywhere.
