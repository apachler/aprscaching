# Rule: docs & comments describe the present, not the journey

**Scope.** Every comment and every piece of prose in the repository: code comments (`//`, `/* */`,
`--` in SQL, `#` in YAML/TOML), JSDoc, Markdown docs (`README`, `docs/`, `INDEX`, this repo's rules),
and the test-title strings passed to `describe()` / `it()` / `test()`. Claude Code MUST hold this rule
whenever it writes or edits any of them.

Keywords: **MUST / MUST NOT / SHOULD / MAY** (RFC 2119).

---

## The one rule

> **Comments and docs state what the software IS and WHY — as present fact. They never narrate how it
> got that way.** A reader arriving today should learn the current design and its rationale, with no
> trace of the milestones, phases, reviews, or superseded plans that produced it.

The development history lives in exactly three places, and nowhere else:
- **git history / PRs** — the change-by-change record.
- **`CHANGELOG.md`** — the human-readable release record (the one file where past tense is correct).
- **`TODO.md`** — what is intentionally deferred (forward-looking, not backward).

Everything else is present-tense.

---

## MUST NOT — the iterative residue to keep out

1. **Process/sequence codes.** No milestone, phase, stage, slice, or track labels in comments or docs:
   `M0`–`M9`, `Stage 2A`, `Phase B`, `Slice A`, `P1`–`P4`, `T3a`–`T3e`, `A1/A2`, `B1`–`B3`, and the
   hardware/feature tracks `H1`–`H6`, `W1`–`W4`, `F-1`–`F-8`. Name the thing, not its plan slot.
2. **Review / ticket IDs.** No `SR-SEC-07`, `SR-TRUST-02`, `SR-*`, or similar audit tags. Keep the
   invariant they guarded; drop the tag.
3. **ADR labels.** No `ADR-3` / `ADR-4b`. State the decision as a standing rule.
4. **Dead planning-doc pointers.** No references to removed or numbered planning docs (`docs/09`,
   `docs/26`, `PLAN.md`, `AUTH_AND_ANNOUNCE.md`, `HAPPY-CODING.md`, `STABILITY-REVIEW.md`), and no
   empty ``` `` ``` link placeholders left behind when one is stripped. Link the live `docs/` manual or
   inline the substance.
5. **Temporal / story framing.** No "reborn", "greenfield", "squashed baseline", "for now",
   "deferred while …", "originally", "previously", "used to", "the previous X", "grew unbounded",
   "now we …", or "was broken → now fixed". Describe the current behavior and the threat/edge it
   handles, in the present tense.

---

## MUST — what to write instead

- **State the invariant as present fact, and keep the WHY.** The reason a guard, cast, or odd-looking
  branch exists is the most valuable part of a comment — keep it. Only strip the ID and the history.
  - ✗ `// SR-SEC-12: an unauthenticated begin used to pre-claim the account; now we insert only on verify`
  - ✓ `// Create the account only once the ceremony verifies — an unauthenticated begin must not pre-claim it`
- **Name capabilities directly** using the canonical phrasing below.
- **Keep real domain vocabulary.** Tier A / B / C (the trust model), q-constructs (`qAR`/`qAC`/`qAX`),
  `AGPL §13`, and protocol names (APRS-IS, AX.25, KISS, NET/ROM, FBB, Meshtastic, CWOP, TAK/CoT) are
  the subject matter, not process codes — use them freely.
- **Prune to present relevance.** If a comment only made sense relative to an earlier version, delete
  it; if it explains current behavior, keep it (de-historicized).

### Canonical phrasing
| Instead of… | Write… |
|---|---|
| `H5-gated`, `gated (H5)`, `H5 transmit` | *gated on callsign control-verification* |
| `H1/H2/H3/H4` | *Web Serial KISS* / *BLE-KISS* / *Meshtastic over Web Serial* / *soundcard Bell-202 AFSK* |
| `W1/W2/W3/W4` | *direct PWS ingest* / *APRS-IS weather beacon* / *CWOP relay* / *browser-direct serial weather* |
| `F-1 … F-8` | the feature by name (virtual cache, NFC stage unlock, cache media, living-cache rendezvous, 1–5 rating, 10-char Maidenhead, drive-in/country/tags) |
| `M9 auth`, `M5 workbench` | *auth*, *the workbench* (drop the code) |
| `SR-XXX-NN: <desc>` | `<desc>` as a present-tense statement |

---

## Runtime strings, too

User-facing strings (thrown errors, HTTP response bodies, UI copy) MUST NOT carry process codes
either — e.g. an error body must say `verify <call> to transmit — control-verification required`, not
`… (H5)`. These are read by users, so the bar is the same.

---

## Applies to NEW code

This is not a one-time cleanup — it is the standing bar for every comment and doc written from now on.
Write it present-tense the first time. A change that adds a milestone/review/phase tag to a comment or
doc is a defect in review, the same as a failing test.

---

## Pre-commit checklist (self-check before committing comments/docs)
- [ ] No milestone/phase/stage/track code (`M#`, `Stage/Phase/Slice`, `P#`, `H#`, `W#`, `F-#`, `T3x`).
- [ ] No `SR-*` review IDs and no `ADR-N` labels.
- [ ] No references to removed/numbered planning docs and no empty ``` `` ``` link stubs.
- [ ] No "for now / previously / used to / reborn / greenfield / squashed / was-broken-now-fixed".
- [ ] The rationale (the WHY) survived; only the history and the tag were removed.
- [ ] Domain terms (Tier A/B/C, q-constructs, protocol names) are intact.
