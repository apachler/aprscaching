# @aprscaching/tools

The plugin platform behind the Shack's **Tools** app: the tool manifest and its validator, the capability and
surface model, the declarative panel and map-layer formats, the tool host, manifest and registry signing, the
signal decoders, and the built-in tools. It has no runtime dependency outside the workspace and runs the same in
the browser, a Worker, Node and Bun. MIT-licensed, so other projects can embed it.

## What is in it

| Module | Exports |
|---|---|
| `manifest.ts` | `ToolManifest`, `validateManifest()`, `connectOrigin()` |
| `capabilities.ts`, `surfaces.ts` | The capability and surface names, `isGated()` |
| `panel.ts`, `maplayer.ts` | `PanelSpec`, `MapLayerSpec`, and `sanitizePanel()` / `sanitizeMapLayer()` for untrusted input |
| `host.ts` | `ToolHost`: registers tools, enforces their capabilities, routes events and the bus between tools |
| `registry.ts` | Ed25519 manifest and registry signatures, `verifyRegistry()`, `resolveTrust()` |
| `decoders/` | CW, PSK31 and 7PLUS decoders, and the streaming audio decoders |
| `builtins/` | The first-party tools the app ships, all off until the user turns them on |
| `macros.ts`, `session-script.ts` | CTEXT macros and the connected-mode session scripts |

The sandbox that runs an imported tool lives in the web app (`apps/web/src/tools/sandbox.ts`); this package is
what it and the app share.

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

- [Write your first tool](../../docs/contribute/first-tool.md): build, run, test and publish a tool.
- [Tool reference](../../docs/contribute/tool-reference.md): the manifest, the script API, the messages and the
  limits.
- [Writing a Shack plugin](../../docs/contribute/plugins.md): how the plugin system fits together.

## Licence

MIT, see [`LICENSE`](LICENSE). Contributions are licensed the same way.
