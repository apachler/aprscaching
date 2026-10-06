# @aprscaching/tools

The plugin platform behind the Shack's **Tools** app: the tool manifest and its validator, the capability and
surface model, the declarative panel and map-layer formats, the tool host, manifest and registry signing, and the
signal decoders the app's audio front-end runs. It has no runtime dependency and runs the same in
the browser, a Worker, Node and Bun. MIT-licensed, so other projects can embed it.

## What is in it

| Module | Exports |
|---|---|
| `manifest.ts` | `ToolManifest`, `validateManifest()`, `connectOrigin()` |
| `capabilities.ts`, `surfaces.ts` | The capability and surface names, `isGated()` |
| `panel.ts`, `maplayer.ts` | `PanelSpec`, `MapLayerSpec`, and `sanitizePanel()` / `sanitizeMapLayer()` for untrusted input |
| `host.ts` | `ToolHost`: registers tools, enforces their capabilities, routes events and the bus between tools |
| `registry.ts` | Ed25519 manifest and registry signatures, `verifyRegistry()`, `resolveTrust()` |
| `decoders/` | CW and PSK31 decoders, and the streaming audio decoders |
| `macros.ts`, `session-script.ts` | CTEXT macros and the connected-mode session scripts |

The app has no tools of its own: every tool, the project's first-party ones included, is a signed script from a
registry that the app runs in a sandbox (`apps/web/src/tools/sandbox.ts`). This package is what the sandbox and
the app share. The project's tools live in [`apachler/aprscaching-tools`](https://github.com/apachler/aprscaching-tools),
which bundles the MIT modules here into each tool's script.

## Use it

The package is part of the repository's pnpm workspace and is not published to npm. Its entry is the TypeScript
source (`src/index.ts`), which Vite, Vitest, esbuild and Bun read as is. In another workspace package:

```json
{ "dependencies": { "@aprscaching/tools": "workspace:*" } }
```

Validate a manifest and check its signature:

```ts
import { validateManifest, checkManifestSignature } from "@aprscaching/tools";

const v = validateManifest(JSON.parse(text));
if (!v.ok) throw new Error(v.error);
const sig = await checkManifestSignature(v.manifest); // "unsigned" | "valid" | "invalid"
```

Run the package's tests:

```bash
pnpm --filter @aprscaching/tools test
```

## Write a tool

A third-party tool does not depend on this package: it is a `tool.json` and a script that the app loads into a
sandbox. `examples/station-log/` is a complete one, and the test suite checks it against the validator.

- [Write your first tool](https://apachler.github.io/aprscaching-tools/write/first-tool/): build, run, test and publish a tool.
- [The manifest](https://apachler.github.io/aprscaching-tools/write/manifest/) and [the sandbox API](https://apachler.github.io/aprscaching-tools/write/sandbox-api/): every field, call and message.
- [Limits and budgets](https://apachler.github.io/aprscaching-tools/write/limits/): what the sandbox allows a tool.
- [Sign a tool](https://apachler.github.io/aprscaching-tools/write/sign/): the author key and what the signature covers.

## Licence

MIT, see [`LICENSE`](LICENSE). Contributions are licensed the same way.
