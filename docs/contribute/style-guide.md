# Style guide for the manual

This page is for anyone who writes or edits the manual. It sets out how a page is built, how it sounds, and
what the checks enforce. The aim: every page reads as one voice, and a reader finds the same shape everywhere.

## Before you start

- Know who the page is for. The manual has six readers: the **player**, the **hider**, the **Shack user**, the
  **sysop**, the **integrator** and the **contributor**. A page serves one of them.
- Know what kind of page it is (next section). A page does one job.
- Install [Vale](https://vale.sh) 3.24 if you want to run the style check locally:
  `vale docs/path/to/page.md`.

## One page, one job

Every page is one of four kinds. Pick one and follow its template.

| Kind | The reader wants to | Example |
|---|---|---|
| **Tutorial** | learn by doing, start to finish, once | Your first find |
| **How-to** | reach one goal they already have | Log a find over the radio |
| **Reference** | look up a fact | HTTP API, Configuration |
| **Explanation** | understand why it works this way | How finds are verified |

A page that mixes them gets split. Steps go in a how-to, background goes in an explanation, and each links to
the other.

### The first two sentences

They say what the page is for, who it is for, and what the reader has at the end.

- Good: "This page shows you how to log a find from the cache with your radio. You need a callsign and an APRS
  radio; at the end the find is on the map, verified."
<!-- vale APRScaching.Filler = NO -->
- Bad: "APRScaching offers a powerful and flexible way to record your achievements."
<!-- vale APRScaching.Filler = YES -->

### Tutorial and how-to template

```markdown
# Log a find over the radio

One or two sentences: what you do, who it is for, what you have at the end.

## Before you start

- What you need (an account, a radio, a verified callsign), each with a link.

## Steps

1. One action per step. UI labels in **bold**: select **Log a find**.
2. Say what you see after the step: "The find shows as **Queued**."

## Check that it worked

What the reader looks at to know it worked.

## Next

- [One or two links](../play/index.md) to where a reader usually goes next.
```

### Reference template

Start with one sentence on what the table or list covers. Then the facts, in a table where they have the same
fields. No steps, no opinions. End with **Next**.

### Explanation template

Start with the question the page answers. Explain with the reader's words first and the precise terms second,
using one diagram where a flow is easier to see than read. End with **Next**.

### Cache-type page template

Every game type gets the same sections, in this order:

1. **What it is**: one paragraph.
2. **How you find it**: what the hunt looks like.
3. **What "found" means**: the condition the game checks.
4. **How it is logged and verified**: the log types and the tier it can reach.
5. **What a hider sets**: the fields, with their defaults.
6. **Example**: one real-looking cache, with placeholders where needed.
7. **Tips**.
8. **Map marker**: the marker and its colour.

## How it sounds

- **Short sentences.** Aim for 20 words or fewer. Vale suggests a split past 30.
- **Active voice, "you", present tense.** "The map shows the cache", not "The cache will be shown".
- **Plain words.** "Use", not "utilise". "Start", not "initiate".
- **Define a term the first time** or link to the [glossary](../glossary.md).
<!-- vale APRScaching.Filler = NO -->
- **No filler and no hype.** Leave out *simply*, *just*, *easily* and *powerful*: they tell the reader how to
  feel instead of what to do. Vale fails on them.
<!-- vale APRScaching.Filler = YES -->
- **No hedging.** Say what the software does. When a fact comes from outside the project and is not checked,
  mark it **Unverified**.
- **The glossary's names, spelled one way**: APRS-IS, IGate, sysop, callsign, the Shack, MeshCom, Tier A /
  B / C. In player pages the tiers are **Radio-verified**, **Location-verified** and **Logged**. Vale fails on
  the common variants (<!-- vale APRScaching.Terms = NO --><!-- vale Vale.Terms = NO -->APRS IS, iGate, call sign, Tier-A,
  Meshcom<!-- vale Vale.Terms = YES --><!-- vale APRScaching.Terms = YES -->).
- **Present tense, no history.** The page says what the software is, not how it got there
  ([`docs-and-comments.md`](https://github.com/apachler/aprscaching/blob/dev/.claude/rules/docs-and-comments.md)).

## How it looks

- **Headings are sentence case and say what the section does**: "Log a find", not "Logging Functionality".
  Vale warns on title case.
- **Inverted pyramid**: what most readers need comes first. Edge cases and detail come last.
- **Scannable**: short paragraphs, lists for parallel items, tables for things with the same fields.
- **A blank line before a list**, and between items when one holds a second paragraph or a note. MkDocs reads
  a marker without one as plain text ("… listen for it. 2. Send that …"); the docs check fails on it.
- **Admonitions only for real warnings**: something that loses data, breaks the law or costs money. A tip is a
  sentence.
- **Screenshots** for UI procedures, made from the demo fixtures (`tools/teaser/docs-shots.mjs` or the
  [visual harness](testing.md#design-and-accessibility)). Each has alt text that says what it
  shows, and a caption when the image carries the point.
- **Diagrams are Mermaid**, never box-drawing characters. The manual draws them in the theme's colours.
- **Working examples**: callsigns like `OE8APR-7`, locators like `JN76`, and `<placeholders>` in angle brackets
  for what the reader fills in.
- **Link text says where it goes**: "[The trust model](../reference/trust-model.md)", never "click here".
- **Every page ends with Next**: one or two links.

## Player pages

Pages in the Play section are read on a phone, outdoors, by someone who is not a sysop:

- No shell commands, configuration keys, file paths or server internals. Where the answer depends on the
  instance, say so and point to the sysop: "Ask your sysop" with a link to the run-an-instance page that covers
  it.
- Vale checks their readability. Aim for a Flesch-Kincaid grade of 9 or below.

## What the checks enforce

| Check | Fails on | Runs in |
|---|---|---|
| Vale (`.vale.ini`, `.vale/styles/APRScaching/`) | filler words, terminology variants (errors); title-case headings, Play-page readability (warnings); sentences over 30 words (suggestions) | docs workflow |
| `tools/checks/docs.mjs` | process codes and story framing, undocumented configuration keys, pages outside the nav, broken links outside the manual, box-drawing diagrams, references to a manual page or heading that does not exist (paths, published URLs, the app's manual links, the doctor's hints), a list item MkDocs would read as text | lint job |
| `mkdocs build --strict` | broken links and anchors inside the manual | docs workflow |
| `apps/web/test/diagrams.test.ts` | a Mermaid block that does not parse | unit tests |

The ham-radio vocabulary Vale accepts is in `.vale/styles/config/vocabularies/Ham/accept.txt`. Add a proper
noun there when Vale wrongly flags it, rather than switching a rule off.

## Next

- [Testing & verification](testing.md): every check and how to run it.
- [Glossary](../glossary.md): the names the manual uses.
