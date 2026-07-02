# Command-line tools

Helper scripts under `tools/` support key management, signing, and verification.

## Federation keys — `tools/fedkey/`

```bash
node tools/fedkey/genkey.mjs            # generate an instance signing key
```

Prints `FED_PRIVATE_KEY` (set it as a secret) and the public key it will publish. Add `--raw` for
machine-readable output. Related:

- `node tools/fedkey/rotatekey.mjs` — produce a signed rotation record (a new key vouched for by the old
  one) for `FED_ROTATIONS`, so peers accept the new key without interruption.
- `node tools/fedkey/signregistry.mjs '<entries-json>'` — sign an instance-registry document with an
  authority key, producing `FED_REGISTRY` + `FED_REGISTRY_KEY`.

## Tool signing — `tools/toolkey/` {#toolkey}

Sign tool plugins and the tool registry so the app can verify them (see
[the tools platform](../guides/workbench.md#trust-for-imported-tools)):

```bash
node tools/toolkey/genkey.mjs                                   # a tool-author keypair
TOOL_PRIVATE_KEY=… node tools/toolkey/sign.mjs manifest tool.json   # sign a tool manifest
TOOL_PRIVATE_KEY=… node tools/toolkey/sign.mjs registry registry.json  # sign a registry's entries
```

The signer canonicalises exactly as the app's verifier does, so the app verifies byte-for-byte what you
signed.

## Development & conformance — `tools/dev/`

```bash
tools/dev/check.sh      # build (typecheck) every unit + run every unit test suite
tools/dev/smoke.sh      # spin a throwaway Node/SQLite gateway and run the runtime conformance suites
tools/dev/verify.sh     # check.sh + smoke.sh — the full pre-commit gate
```

The smoke suites themselves live in `tools/smoke/` (`smoke.mjs`, `geofence.mjs`, and the two-instance
`federation.mjs`) and run against any running gateway via `BASE=…`. `tools/e2e/audio-mic.mjs` drives the live
microphone decode path headlessly in Chromium (used by CI).

!!! note
    `tools/teaser/` and `tools/webauthn/` are internal build/marketing and test helpers, not operator tools.
