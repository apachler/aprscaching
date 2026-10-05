# Write your first tool

This tutorial takes you from an empty folder to a working Shack tool that lists the stations the app hears. It is
for developers who know some JavaScript. At the end your tool runs in your local app and has a test, ready to host
and list in a registry.

## Before you start

- Node 22 or newer, and a checkout of the repository with `pnpm install` run once
  ([Run from source](run-from-source.md)). You need it for the local app, the validator and the signing tool.
- A Chromium-based browser, Firefox or Safari for the local app.
- The [Tool reference](tool-reference.md) open beside you: it lists every field and message this page uses.

## Steps

### Start from the example

1. Copy the example tool to a folder of your own:

    ```bash
    cp -r packages/tools/examples/station-log ~/my-tool
    ```

    It holds three files: `tool.json` (the manifest), `tool.js` (the script) and `serve.mjs` (a small local web
    server).

2. Open `tool.json` and give the tool its own identity:

    ```json
    {
      "name": "my-station-log",
      "title": "My station log",
      "author": "<your callsign>",
      "version": "0.1.0",
      "permissions": ["command", "panel", "ipc"],
      "surfaces": ["web", "terminal"],
      "description": "Lists the stations the Station DB tool hears.",
      "entry": "tool.js"
    }
    ```

    `name` is lower case, 2 to 40 characters of `a-z`, `0-9` and `-`. `permissions` is everything the tool will
    ask the user for: here a command, a panel and the bus between tools. `surfaces` puts the panel in the
    **Tools** app and the packet terminal.

### Read the script

`tool.js` is the body of a function the sandbox calls with two arguments: `register` and `ipc`. It has no
`import`; everything is in this one file.

1. It subscribes to `station.seen`, which the built-in **Station DB (NAMES.GP)** tool publishes for every station
   the app hears, and redraws its panel with `ipc.setPanel()`:

    ```js
    if (ipc) {
      ipc.subscribe("station.seen", (data) => {
        // keep the ten newest { call, type, source } entries, then:
        ipc.setPanel(panel());
      });
    }
    ```

2. It calls `register()` once, with two commands and a first panel:

    ```js
    register({
      commands: {
        seen: () => seen.map((s) => `${s.call}  ${s.type || "-"}  ${s.source || "-"}`),
        whois: (args) => {
          ipc.call("station.type", args.trim().toUpperCase()).then((type) => ipc.setPanel(/* … */));
          return ["Asked Station DB …; the answer shows in the panel."];
        },
      },
      panel: panel(),
    });
    ```

    A command answers at once with its lines. `/whois` asks another tool through `ipc.call()`, which answers
    later, so its result goes to the panel.

3. A panel is data, not HTML: a title and a list of nodes such as `kv`, `table` and `text`. The app draws it with
   its own elements, in the user's theme.

Change the panel's title to `My station log` so you can tell your copy from the example.

### Run it in your local app

1. Start the example's server in your tool's folder:

    ```bash
    cd ~/my-tool && node serve.mjs
    ```

    It prints `serving … at http://127.0.0.1:8790/tool.json` and sends the CORS header the app needs to read
    the files.

2. In the checkout, start the web app:

    ```bash
    pnpm dev:web
    ```

3. Open `http://localhost:5173/?demo=app&net=1&view=tools`. `demo=app` runs the whole app on built-in sample
   data with no gateway, `net=1` lets it reach your server, and `view=tools` opens **Shack → Tools**.
4. Turn on **Station DB (NAMES.GP)** in the list of tools.
5. Under **Import a tool**, enter `http://127.0.0.1:8790/tool.json` and select **Import…**.

    The prompt shows **My station log by `<your callsign>` requests: command, panel, ipc** and the label
    **Unsigned · you're trusting the URL only**.

6. Select **Approve + run**. A toast says the tool was imported, and the **My station log** panel appears.
7. Under **Run a tool command**, enter `/whois OE6XRR-9` and select **Run**.

To load a change to the script, reload the page and import the tool again: an imported tool lasts until the page
reloads.

## Check that it worked

- The panel **My station log** shows under the list of tools.
- `/seen` answers `No stations heard yet.`, or a list of stations.
- After `/whois OE6XRR-9`, the panel's first row shows `OE6XRR-9` with its type, or `not heard`.

The demo data never hears a new station, so the station table stays empty there. Against a gateway that hears
stations (`pnpm dev:gateway` with an ingest, [Run from source](run-from-source.md)) and with **Live stations**
switched on, the table fills as stations are heard.

## Test it

Two tests keep the tool honest. The repository runs both for the example; copy them for your tool.

1. **The manifest passes the validator.** In a test under the checkout's `packages/tools/test/`:

    ```ts
    import { validateManifest } from "../src/index.js";

    const v = validateManifest(JSON.parse(readFileSync("<path>/tool.json", "utf8")));
    expect(v.ok).toBe(true);
    ```

2. **The script runs the way the sandbox runs it.** Evaluate it with stand-ins for `register` and `ipc`, then
   call its commands and deliver bus messages:

    ```ts
    let reg;
    new Function("register", "ipc", script)((t) => (reg = t), fakeIpc);
    expect(reg.commands.seen("")).toEqual(["No stations heard yet."]);
    ```

    Pass every panel through `sanitizePanel()` and check it comes back unchanged: what the sanitiser trims is what
    users would not see.

`packages/tools/test/example-tool.test.ts` is the full version, and `tools/e2e/tool-sandbox.mjs` loads the
example in the real sandbox in headless Chromium. Run them with:

```bash
pnpm --filter @aprscaching/tools exec vitest run test/example-tool.test.ts
pnpm run e2e:tools
```

## Package and host it

A tool is its two files on a web server. The app fetches both from the user's browser, so the server must:

- serve them over `https://` (a browser blocks `http://` from an `https://` page);
- send `Access-Control-Allow-Origin: *`. GitHub Pages does this for every file;
- serve the script as one readable file. A reviewer reads the bytes you host.

Put the manifest's URL somewhere users find it. Anyone can import the tool by that URL.

## Sign it

Signing proves the manifest was not changed since you signed it, and lets a registry vouch for your key.

1. Make a key pair once, in the checkout, and keep the private value secret:

    ```bash
    node tools/toolkey/genkey.mjs
    ```

2. Sign the manifest. The signer adds your `pubkey` and the `signature`:

    ```bash
    TOOL_PRIVATE_KEY=<private value> node tools/toolkey/sign.mjs manifest ~/my-tool/tool.json
    ```

3. Sign again after every change to the manifest, a new `version` included.

!!! warning "Signed manifests are refused"
    The app's signature check and `tools/toolkey` serialise unset optional fields differently. A signed
    manifest therefore shows as **Signature INVALID** and the import stops, unless it sets both `remote: true`
    and `connect`. Leave the tool unsigned until the fix lands;
    [Signing and trust](tool-reference.md#signing-and-trust) has the detail.

The signature covers the manifest, including the `entry` URL, but not the script's bytes. Serve the script from a
URL you never reuse for different code, such as one with the version in its path.

## List it in a registry

The **Registry** list in the Tools app shows one signed file per build of the app: `VITE_TOOL_REGISTRY`
(`/tools/registry.json` by default), verified against the authority key `VITE_TOOL_REGISTRY_AUTHORITY`. The
project's builds ship `apps/web/public/tools/registry.json`; a sysop who builds the app can point both settings at
a registry of their own ([Configuration](../reference/configuration.md)).

To be listed, give the registry's keeper the entry for your tool:

| Field | Value |
|---|---|
| `name`, `title`, `author`, `version`, `description` | As in your manifest |
| `pubkey` | Your public key, exactly as in the signed manifest |
| `entry` | The URL of your `tool.json` |

The keeper adds the entry and signs the registry again with
`TOOL_PRIVATE_KEY=<authority key> node tools/toolkey/sign.mjs registry registry.json`. Once the new registry is
deployed, your tool shows with the **verified** badge, and importing it shows **Verified · registry-listed author
key**. For the project's registry, open a pull request that adds your entry; the maintainers sign it.

### What a reviewer checks

- The manifest passes the validator and asks only for the permissions the script uses.
- The script is readable, not minified, and does what its description says.
- `network` names only the origins the tool needs, each one for a stated reason.
- Nothing pretends to be the app: panels and command output say they come from the tool.
- The listing states the tool's licence and links its source.
- The `entry` URL serves the reviewed bytes and does not change under the same version.

## Next

- [Tool reference](tool-reference.md): every field, message and limit.
- [Writing a Shack plugin](plugins.md): how the plugin system fits together.
