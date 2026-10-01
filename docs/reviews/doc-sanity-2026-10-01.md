# Documentation sanity pass — October 2026

!!! info "Review dated 1 October 2026"
    This is a point-in-time review record. It describes the documentation sanity pass as it finished on
    `dev` at commit `54debdb`, and is not updated as the documentation moves on. The inventory it works from is
    [Documentation inventory — October 2026](doc-inventory.md).

## Summary

The pass read every documentation file in full — the manual, the root documents, the agent rules, `TODO.md`
and the READMEs under `deploy/`, `tools/`, `apps/` and `servers/`, 59 files — and checked each concrete claim
against the code. It found **79 issues**, fixed 70 of them across eight pull requests, and confirmed two need no
change. The remaining seven are larger rewrites or small cleanups, listed under [Follow-ups](#follow-ups).

The documentation now describes the software as it is, matches the code on every checked configuration key,
route, command, path, number and UI label, reads for the audience of each section, and is organised by reader.
A CI check keeps it that way.

| Pull request | Phase | What it did |
|---|---|---|
| #129 | Inventory (DOC-01) | The inventory; dated review records kept out of the nav |
| #130 | Present state (DOC-02) | History, plan codes and story wording rewritten as present fact |
| #131 | Correctness (DOC-03) | Every documented fact matched to the code |
| #132 | Screenshots | All ten regenerated from the current UI; two tooling fixes |
| #133 | Audience (DOC-04) | Glossary, first-use links, prerequisites, checks, compliance links, API auth |
| #135 | Checks (DOC-07) | `tools/checks/docs.mjs` in CI; broken anchors fail the strict build |
| #136 | Structure (DOC-05) | Nav by reader; one explanation per topic |
| #137 | Root documents (DOC-06) | README, INDEX, CONTRIBUTING, SECURITY, CLAUDE.md, the agent rules, TODO.md |

## Findings by type

| Type | Found | Fixed | Not changed | Open |
|---|---|---|---|---|
| Present state (DOC-02) | 12 | 12 | — | — |
| Correctness (DOC-03) | 23 | 22 | 1 (DOC-03-19: the doc was right) | — |
| Audience fit (DOC-04) | 13 | 13 | — | — |
| Structure and navigation (DOC-05) | 19 | 12 | 1 (DOC-05-08: concepts follows the guides by design) | 6 (DOC-05-10, 05-11, 05-12, 05-13, 05-18, 05-19) |
| Root documents and rules (DOC-06) | 12 | 11 | — | 1 (DOC-06-12, package READMEs) |
| **Total** | **79** | **70** | **2** | **7** |

The correctness pass also covered the whole surface, not only the listed findings:

- **Configuration:** the two-way diff between the keys the code reads and `reference/configuration.md` is
  empty — 159 keys, each documented, and no documented key unread. Deploy-script and Pocket keys gained their
  own section.
- **Routes:** every route in `reference/api.md` exists, every table has an Auth column checked against its
  handler, and the routes missing from it (`/api/watch`) are added.
- **Paths, scripts and UI labels:** every repository path and `pnpm` script named in the docs exists; every
  `Settings →`, `You →`, `Shack →` and `Instance admin →` path matches a label in `apps/web/src`.
- **Links:** 148 external links checked. Two are dead (the Pocket install URLs, below); the rest respond or
  could not be reached from the review environment (listed under [External facts](#external-facts)).

## Gate decisions

| Gate | Decision |
|---|---|
| G1 — where the inventory and report live | (a) `docs/reviews/`, dated, outside the nav (`not_in_nav`) |
| G2 — automated documentation checks | (a) A check script in CI that fails the build |
| G3 — when docs and code disagree | (a) Docs follow code; where the code looks wrong, the docs say **Known issue** and the case is reported |
| G4 — jargon for newcomers | (a) A glossary page, linked at each term's first use |
| G5 — screenshots | (a) Regenerate all, review each, in a separate pull request |

## Doc–code disagreements

Most disagreements were outdated documentation, fixed by following the code. These are the ones where the code
itself looks wrong or the documented behaviour is not true yet; the docs carry a **Known issue** where a reader
could be misled.

| # | Disagreement | Resolution | Code |
|---|---|---|---|
| 1 | **The web BBS routes are not authenticated.** `POST /api/bbs/messages` accepts any `fromCall`; `GET /api/bbs/messages?to=` and `/api/bbs/sent?from=` return any callsign's personal mail; `POST /api/bbs/messages/:id/read` marks any message read; `POST /api/bbs/wp` sets any callsign's home BBS, which steers where FBB forwarding sends that callsign's mail. | **Suspected bug — security/integrity.** Known issue in `reference/api.md`; gating these routes is a code change | `workers/gateway/src/bbs.ts`, `forward.ts` |
| 2 | **The Pocket install URL answers 404.** `pocket.sh` installs from `main`, which holds only the root commit until the first release. | Known issue in `operate/pocket.md` and `deploy/pocket/README.md`, with the working `dev` command | `deploy/pocket/pocket.sh` |
| 3 | The compliance page promised configurable duty-cycle and rate limits and identification intervals. | Docs follow code: the limits are fixed token buckets and the NODES interval. Whether to add configurable limits is an owner decision | `apps/ingest/src/boxpoll.ts`, `meshcom-send.ts` |
| 4 | `BACKUP_RETENTION_DAYS` is said to prune "at the destination", but only `BACKUP_DIR` is pruned; bucket backups grow without limit. | Docs follow code and advise a bucket lifecycle rule; the script's header comment still states the old behaviour | `deploy/backup.sh` |
| 5 | The docs screenshot tool produced empty frames: its gateway refused the preview origin (CORS), and the WebP step could not find a browser. | Fixed in #132; the browser path `/opt/pw-browsers` stays hard-coded, documented in its README | `tools/teaser/run-tour.sh`, `run-docs.sh` |
| 6 | "Run from source" failed as written: the gateway refuses to start without `INGEST_SECRET` and does not read `.env`. | Docs follow code: every runtime is told to set it | `servers/node/src/secrets.ts` |
| 7 | Every admin write was said to accept `x-operator-secret`; verifications, adoptions and setup accept a sysop session only. | Docs follow code, per route | `workers/gateway/src/admin.ts` `requireSysop` |

Code comments that still state an old fact, for the separate comments pass: `workers/gateway/src/app.ts` calls
`/federation/bbs/enqueue` "(sysop/ingest)" (it is sysop or `x-operator-secret`), and the `deploy/backup.sh`
header (row 4).

## External facts

Facts the repository cannot settle stay marked **Unverified** in the manual, with what would settle them:

- **44Net** (`operate/44net.md`, `operate/pocket.md`, `operate/rf-ingest.md`): the Connect cost and allocation
  size, certificate issuance on a live Connect address, subdomain delegation end to end, the `AllowedIPs` and
  return routing of a Connect tunnel, whether IP protocol 93 (AXIP) passes between Connect addresses,
  HAMNET ↔ Connect reachability, and Android delivering inbound connections on the VPN interface.
- **T-Deck map** (`design/meshcom-tdeck-map.md`): how the firmware draws its map, and whether it shows APRS
  objects.
- **ampr.org DNSSEC:** unsigned as checked on 2026-09-30, dated wherever it is stated.
- **The 44Net address space:** `operate/44net.md` gives AMPRNet as `44.0.0.0/8`. Part of that block was sold
  in 2019, so the range is likely narrower; check against ARDC's current pages before relying on it.

External links the review environment could not reach (bot protection or the network proxy, not known to be
dead): aprs.org (APRS101, APRS 1.1/1.2), apps.dtic.mil, iso.org, mitre.org, tele.soumu.go.jp,
apc-cap.ic.gc.ca, callbook.rdi.nl, hamlib.sourceforge.net, linux-ax25.org, `dns.quad9.net:5053`. All twelve
GitHub repositories the docs cite exist.

## Checks now in place

- `tools/checks/docs.mjs`, in the `lint + format` job on every pull request: history codes and story wording
  outside `CHANGELOG.md`/`TODO.md`/`docs/reviews/`; configuration keys missing from the reference or
  documented but unread; nav entries without a file and pages outside the nav; broken links in the root
  documents and READMEs.
- `mkdocs.yml` `validation.anchors: warn`, so `mkdocs build --strict` fails on a link to a missing heading.
- The docs rule (`.claude/rules/docs-and-comments.md`) names the check and what it cannot judge.

## Follow-ups

In priority order:

1. **Gate the web BBS routes** (disagreement 1) — require a session holding the call for mailbox reads,
   posting and marking read, and the operator or the ingest box for White Pages writes.
2. **Publish the first release**, which closes the Pocket 404 and the README's release badge and one-click
   Oracle Cloud link; or point those at `dev` until then.
3. **Set the launch-list date** in `TODO.md` ("end of September 2026" has passed).
4. **Split `operate/pocket.md`** (481 lines: install, extras, 44Net, federation, feasibility) and
   **`operate/administration.md`** (eleven topics: sysop identity, content administration, data protection)
   into pages a reader can finish (DOC-05-12, DOC-05-13).
5. **Decide on configurable transmit limits** (disagreement 3) and **prune bucket backups** or document a
   lifecycle rule as required (disagreement 4).
6. **Smaller structure cleanups:** move the 44Net onboarding steps out of the wire-format reference into
   `operate/44net.md` (DOC-05-11); move the upstream issue drafts out of `design/meshcom-tdeck-map.md`
   (DOC-05-18); use or remove the unused `assets/shots/map-mobile.webp` (DOC-05-19); and settle on one home
   each for the backup, secrets and off-grid notes (DOC-05-10).
7. **Add READMEs to the MIT packages** (`packages/*`), which are meant to be embedded by other software
   (DOC-06-12).
8. **The comments pass:** the same rule applied to code comments, starting with the two named above.
9. **Verify the 44Net address range** against ARDC and settle the Unverified 44Net items on a live Connect
   address.
