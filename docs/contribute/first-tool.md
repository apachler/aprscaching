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

`tool.js` is the body of a function the sandbox calls with three arguments: `register`, `ipc` and `tool`. It has
no `import`; everything is in this one file. This example uses `register` and `ipc`; `tool` holds the rest of the
API: events, the map, colours and transmitting ([Tool reference](tool-reference.md#tool)).

1. It subscribes to `station.seen`, which the **Station DB (NAMES.GP)** tool from the project registry publishes
   for every station the app hears, and redraws its panel with `ipc.setPanel()`:

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

3. The app installs only signed tools. Make a key and sign your copy, as [Sign it](#sign-it) shows:

    ```bash
    node tools/toolkey/genkey.mjs
    TOOL_PRIVATE_KEY=<private value> node tools/toolkey/sign.mjs manifest ~/my-tool/tool.json
    ```

4. Open `http://localhost:5173/?demo=app&net=1&view=tools&tools=station-db`. `demo=app` runs the whole app on
   sample data with no gateway, `net=1` lets it reach your server, `view=tools` opens **Shack → Tools**, and
   `tools=station-db` installs **Station DB (NAMES.GP)** from the project registry the app bundles.
5. Under **Install by address**, enter `http://127.0.0.1:8790/tool.json` and select **Install…**.

    The prompt shows **My station log by `<your callsign>` requests: command, panel, ipc** and the label
    **Signed · unknown author key (trust-on-first-use)**.

6. Select **Approve and install**. A toast says the tool was installed, and the **My station log** panel appears.
7. Under **Run a tool command**, enter `/whois OE6XRR-9` and select **Run**.

To load a change to the script, sign the manifest again and reload the page: the app starts your installed tools
again, and runs the new script once its hash matches the signed manifest.

## Check that it worked

- The panel **My station log** shows under the list of tools.
- `/seen` answers `No stations heard yet.`, or a list of stations.
- After `/whois OE6XRR-9`, the panel's first row shows `OE6XRR-9` with its type, or `not heard`.

The demo data never hears a new station, so the station table stays empty there. Against a gateway that hears
stations (`pnpm dev --ingest`, [Run from source](run-from-source.md)) and with **Live stations**
switched on, the table fills as stations are heard.

## Test it

Two tests keep the tool honest. The repository runs both for the example; copy them for your tool.

1. **The manifest passes the validator.** In a test under the checkout's `packages/tools/test/`:

    ```ts
    import { validateManifest } from "../src/index.js";

    const v = validateManifest(JSON.parse(readFileSync("<path>/tool.json", "utf8")));
    expect(v.ok).toBe(true);
    ```

2. **The script runs the way the sandbox runs it.** Evaluate it with stand-ins for `register`, `ipc` and `tool`,
   then call its commands and deliver bus messages:

    ```ts
    let reg;
    new Function("register", "ipc", "tool", script)((t) => (reg = t), fakeIpc, fakeTool);
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

A tool is its two files on a web server. The app fetches both from the user's browser (or through the instance,
for a registry it carries), so the server must:

- serve them over `https://` (a browser blocks `http://` from an `https://` page);
- send `Access-Control-Allow-Origin: *`. GitHub Pages does this for every file;
- serve the script as one readable file. A reviewer reads the bytes you host.

Put the manifest's URL somewhere users find it. Anyone can install the tool by that URL.

## Sign it

The app installs only signed tools. Signing proves the manifest and its script were not changed since you signed
them, and lets a registry vouch for your key.

1. Make a key pair once, in the checkout, and keep the private value secret:

    ```bash
    node tools/toolkey/genkey.mjs
    ```

2. Sign the manifest. The signer hashes the script `entry` names next to the manifest into `entrySha256`, then
   adds your `pubkey` and the `signature`. When `entry` is an absolute address, give the script's file as a third
   argument:

    ```bash
    TOOL_PRIVATE_KEY=<private value> node tools/toolkey/sign.mjs manifest ~/my-tool/tool.json
    ```

3. Sign again after every change to the manifest or the script, with a new `version`.

The app refuses a script whose bytes differ from `entrySha256`, so host exactly the file you signed.

## List it in a registry

A registry is a signed list of tools that the **Tools** app shows under **Registry**. Anyone can publish one, for
example on GitHub ([Host a registry on GitHub](tool-registry.md#host-a-registry-on-github)); a sysop or a player
adds it by its address and pins its key. To be listed, give the registry's keeper the entry for your tool:

| Field | Value |
|---|---|
| `name`, `title`, `author`, `version`, `description` | As in your manifest |
| `pubkey` | Your public key, exactly as in the signed manifest |
| `entry` | The address of your `tool.json`, absolute or relative to the registry |

Installing the tool from the entry's address then shows **Signed · registry-listed author key**. A copy installed
from any other address gets the trust-on-first-use label.

The project registry lives in its own repository, [apachler/aprscaching-tools](https://github.com/apachler/aprscaching-tools):
its `CONTRIBUTING.md` covers submitting a tool and its `MAINTAINERS.md` covers signing and releases. Each
APRScaching release bundles a tagged snapshot of it.

### What a reviewer checks

- The manifest passes the validator and asks only for the permissions the script uses.
- The script is readable, not minified, and does what its description says.
- `network` names only the origins the tool needs, each one for a stated reason.
- Nothing pretends to be the app: panels and command output say they come from the tool.
- The listing states the tool's licence and links its source.
- The `entry` URL serves the reviewed bytes and does not change under the same version.

## Next

- [Tool reference](tool-reference.md): every field, message and limit.
- [The tool registry](tool-registry.md): how a listing works and how to run a registry.
