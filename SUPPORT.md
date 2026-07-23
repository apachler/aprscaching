# Getting Support

aprscaching is a volunteer, non-commercial project. There is **no paid support** — help is
community-driven, and that's on purpose.

## Where to go

1. **Read the manual.** The product manual (served with MkDocs, source in `docs/`) covers getting
   started, operating an instance, RF ingest, federation, and the API/config reference.
2. **Search existing issues** — your question may already be answered.
3. **Ask a question** — open an issue using the **Question / Support** template, or start a GitHub
   Discussion if the repo has them enabled. For anything RF-hardware-specific (a TNC, rig, Web-Serial,
   Meshtastic, or KISS problem), use the **RF hardware report** template so we get rig/TNC/connection
   details up front.
4. **Report a bug** with the bug template, or a **security issue privately** per
   [`SECURITY.md`](SECURITY.md) (never in a public issue).

## What to include

- Which runtime/topology (browser PWA, Node self-host, Bun desktop binary, Cloudflare Worker, the Pi
  ingest box) and version/commit.
- What you expected vs. what happened, and the smallest reproduction you can manage.
- Relevant logs — but scrub secrets (`INGEST_SECRET`, `FED_PRIVATE_KEY`, tokens, callsign passcodes).

## Supporting the project

aprscaching is **free in full** — every feature, forever, for everyone. Donations (when available) are
**recognition-only** and never unlock functionality or gate features. Being open-source under AGPL
also satisfies the open-access requirement behind the project's grant funding. If you want to help
without money: run an instance, file good bug reports, improve the docs, or test on hardware we can't.

73.
