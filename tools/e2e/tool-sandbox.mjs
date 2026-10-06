// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * tool-sandbox.mjs — a headless Chromium end-to-end test for the tool sandbox (`apps/web/src/tools/sandbox.ts`).
 * It bundles the real module with the ToolHost, loads tools into it from a page that holds a session cookie and an
 * IndexedDB database, and asserts what a tool reaches:
 *
 *   1. the example hello tool loads, answers its command and runs its decoder, and the station-log example
 *      (packages/tools/examples/station-log) talks to the bus through its context;
 *   2. a tool using the whole API reaches the host only through its grants: events with a session reply, async
 *      commands, transmit and beacons behind the gate and the rate limit, a map layer, colour rules, and a
 *      service it provides on the bus, connected sessions (on_connect/on_disconnect, the reply through the surface's
 *      gate, remote commands on incoming sessions) and the link topics; a tool without a grant is refused; the
 *      signed tools of the bundled registry (auto-responder, connect-bell, away-note, info-responder, link-ping)
 *      work unchanged on a connected session;
 *   3. a tool without the network grant reaches no network (fetch, XHR, nested Worker, EventSource) and no
 *      app storage (IndexedDB, Cache Storage, localStorage, cookies);
 *   4. a tool with the network grant reaches its `connect` origin, without the page's cookie, and not the
 *      app's own origin.
 *
 * If no Chromium is found it prints SKIP and exits 0, like the other e2e scripts.
 * Browser resolution: $CHROMIUM_PATH, then /opt/pw-browsers/chromium-*, then playwright-core's registry.
 */
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try {
    for (const d of readdirSync("/opt/pw-browsers")) {
      if (!d.startsWith("chromium-")) continue;
      const p = `/opt/pw-browsers/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  } catch {
    /* no such dir */
  }
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return null;
}

// A tool that tries every way out it knows, then answers `/probe` with what each attempt did.
const probeTool = (appUrl, peerUrl) => `
  const out = {};
  const attempt = async (name, fn) => { try { out[name] = "reached: " + String(await fn()); } catch (e) { out[name] = "blocked"; } };
  const done = (async () => {
    await attempt("fetchApp", async () => (await fetch(${JSON.stringify(appUrl + "/probe")})).status);
    await attempt("fetchPeer", async () => (await fetch(${JSON.stringify(peerUrl + "/peer")})).text());
    // The peer allows no credentialed reads, so this response stays unreadable; the peer still records the
    // request's cookie header, which is what the test checks.
    await attempt("fetchPeerCreds", async () => (await fetch(${JSON.stringify(peerUrl + "/peer-creds")}, { credentials: "include" })).text());
    await attempt("xhr", () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.onload = () => res(x.status); x.onerror = rej; x.open("GET", ${JSON.stringify(appUrl + "/probe")}); x.send(); }));
    await attempt("worker", () => new Promise((res, rej) => { const w = new Worker(URL.createObjectURL(new Blob(["fetch(" + ${JSON.stringify(JSON.stringify(appUrl + "/probe"))} + ").then(r => postMessage(r.status), () => postMessage('x'))"]))); w.onmessage = (e) => e.data === "x" ? rej() : res(e.data); w.onerror = rej; setTimeout(rej, 3000); }));
    await attempt("eventSource", () => new Promise((res, rej) => { const s = new EventSource(${JSON.stringify(appUrl + "/probe")}); s.onopen = () => res("open"); s.onerror = () => { s.close(); rej(); }; setTimeout(rej, 3000); }));
    await attempt("indexedDB", () => new Promise((res, rej) => { const r = indexedDB.open("acs-keys"); r.onsuccess = () => res([...r.result.objectStoreNames].join(",") || "empty"); r.onerror = rej; }));
    await attempt("caches", async () => (await caches.keys()).join(",") || "none");
    await attempt("localStorage", () => { if (typeof localStorage === "undefined") throw new Error(); return localStorage.getItem("acs.secret"); });
    await attempt("cookie", () => { if (typeof document === "undefined") throw new Error(); return document.cookie; });
  })();
  register({ commands: { probe: () => [JSON.stringify(out)], ready: () => [String(Object.keys(out).length)] } });
  done;
`;

// The tool API 1.0 contract fixtures: a tool using every 1.0 feature, and one refused what it was not granted.
const apiTool = readFileSync(path.join(ROOT, "tools/e2e/fixtures/tool-api-1.0.js"), "utf8");
const greedyTool = readFileSync(path.join(ROOT, "tools/e2e/fixtures/tool-api-1.0-denied.js"), "utf8");

async function main() {
  const exe = findChromium();
  if (!exe) {
    console.log("SKIP: no Chromium available (set CHROMIUM_PATH or `npx playwright install chromium`)");
    process.exit(0);
  }

  const bundled = await build({
    stdin: {
      contents: `export { loadSandbox, sandboxTool } from "./apps/web/src/tools/sandbox.ts";
        export { ToolHost, SessionEvents } from "./packages/tools/src/index.ts";`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "ToolSandbox",
    write: false,
    platform: "browser",
    target: "es2022",
  });
  const bundleJs = bundled.outputFiles[0].text;
  const helloJs = readFileSync(path.join(ROOT, "apps/web/public/tools/tools/hello/tool.js"), "utf8");
  const stationLogJs = readFileSync(path.join(ROOT, "packages/tools/examples/station-log/tool.js"), "utf8");

  // The peer: a second origin a network-granted tool may reach. It records the cookie header it receives.
  const peerHits = [];
  const peer = createServer((req, res) => {
    peerHits.push({ url: req.url, cookie: req.headers.cookie ?? null });
    res.setHeader("access-control-allow-origin", "*");
    res.end("peer-ok");
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const peerUrl = `http://127.0.0.1:${peer.address().port}`;

  const appHits = [];
  let appUrl = "";
  // The app's remote-command lookup (apps/web installed.ts remoteCommand): a remote tool holding 'command' on the
  // surface, the word not kept for the operator.
  const runnerJs = `window.remoteRunner = (tools) => async (word, args, surface) => {
    for (const { manifest, sb } of tools) {
      if (!manifest.remote || !manifest.permissions.includes("command") || !manifest.surfaces.includes(surface)) continue;
      const reg = sb.commands.find((c) => c.toLowerCase() === word);
      if (reg && !sb.remoteOff.includes(reg)) return { tool: manifest.name, lines: await sb.runCommand(reg, args) };
    }
    return null;
  };`;
  const HTML = `<!doctype html><meta charset=utf-8><title>tool-sandbox-e2e</title><script src="/bundle.js"></script><script>${runnerJs}</script>`;
  const BUNDLED = path.join(ROOT, "apps/web/public/tools/tools");
  const app = createServer((req, res) => {
    if (req.url === "/bundle.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(bundleJs);
    } else if (req.url === "/hello.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(helloJs);
    } else if (req.url === "/station-log.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(stationLogJs);
    } else if (req.url === "/api-tool.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(apiTool);
    } else if (req.url === "/greedy.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(greedyTool);
    } else if (/^\/bundled\/[a-z0-9-]+\/tool\.(js|json)$/.test(req.url ?? "")) {
      res.setHeader("content-type", req.url.endsWith(".js") ? "application/javascript" : "application/json");
      res.end(readFileSync(path.join(BUNDLED, req.url.slice("/bundled/".length))));
    } else if (req.url === "/probe.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(probeTool(appUrl, peerUrl));
    } else if (req.url?.startsWith("/probe")) {
      appHits.push(req.url);
      res.setHeader("access-control-allow-origin", "*");
      res.end("app");
    } else {
      res.setHeader("content-type", "text/html");
      res.end(HTML);
    }
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${app.address().port}`;

  const failures = [];
  const expect = (cond, what) => {
    console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`);
    if (!cond) failures.push(what);
  };

  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("  [page error]", e.message));
    await page.goto(`${appUrl}/`);
    // What the app holds: a session cookie (SameSite=Lax, as the gateway sets it), an IndexedDB key store,
    // a Cache Storage entry and a localStorage value.
    await page.evaluate(async () => {
      document.cookie = "acs_session=secret; SameSite=Lax; path=/";
      localStorage.setItem("acs.secret", "secret");
      await caches.open("app-shell");
      await new Promise((res, rej) => {
        const r = indexedDB.open("acs-keys", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("device");
        r.onsuccess = () => res(r.result.close());
        r.onerror = rej;
      });
    });

    // 1. The hello tool works through the frame.
    const hello = await page.evaluate(async () => {
      const sb = await window.ToolSandbox.loadSandbox(await (await fetch("/hello.js")).text(), [
        "command",
        "monitor",
        "panel",
        "decoder",
      ]);
      const r = {
        commands: sb.commands,
        cmd: await sb.runCommand("hello", "OE8APR"),
        rot: await sb.decode("rot13", "uryyb"),
        rules: sb.colourRules.length,
        panel: !!sb.panel,
        frames: document.querySelectorAll("iframe[sandbox]").length,
      };
      sb.destroy();
      r.framesAfter = document.querySelectorAll("iframe[sandbox]").length;
      return r;
    });
    console.log("hello tool");
    expect(hello.commands.includes("hello"), "registers its command");
    expect(hello.cmd[0]?.includes("Hello OE8APR"), "answers its command");
    expect(hello.rot === "hello", "runs its decoder");
    expect(hello.rules === 1 && hello.panel, "contributes its colour rule and panel");
    expect(hello.frames === 1 && hello.framesAfter === 0, "destroy() removes the frame");

    // The station-log example: it subscribes on the bus, calls a service and pushes panel updates.
    const stationLog = await page.evaluate(async () => {
      const { loadSandbox, sandboxTool, ToolHost } = window.ToolSandbox;
      const host = new ToolHost();
      const calls = [];
      host.registerHostService("station.type", (a) => {
        calls.push(a);
        return "digi";
      });
      const perms = ["command", "panel", "ipc"];
      const sb = await loadSandbox(await (await fetch("/station-log.js")).text(), perms);
      const manifest = {
        name: "station-log",
        title: "Station log",
        author: "X",
        version: "1",
        permissions: perms,
        surfaces: ["web"],
      };
      host.register(sandboxTool(manifest, sb));
      host.setEnabled("station-log", true);
      const settle = () => new Promise((r) => setTimeout(r, 50));
      await settle();
      const subscribed = host.ipcTopics();
      host.hostEmit("station.seen", { call: "OE6XRR-9", type: "digi", source: "APRS" });
      await settle();
      const seen = await sb.runCommand("seen", "");
      await sb.runCommand("whois", "oe6xrr-9");
      let panel = null;
      for (let i = 0; i < 50; i++) {
        panel = host.panels("web")[0]?.spec;
        if (panel?.nodes[0]?.value === "digi") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      sb.destroy();
      return { commands: sb.commands, subscribed, seen, calls, panel };
    });
    console.log("station-log example");
    expect(stationLog.commands.join(",") === "seen,whois", "registers /seen and /whois");
    expect(stationLog.subscribed.join(",") === "station.seen", "subscribes to station.seen");
    expect(stationLog.seen[0] === "OE6XRR-9  digi  APRS", "lists a station it heard on the bus");
    expect(stationLog.calls[0] === "OE6XRR-9", "calls station.type");
    expect(stationLog.panel?.nodes[0]?.value === "digi", "pushes panel updates with the service's answer");

    // 2. The whole API, through the host.
    const api = await page.evaluate(async () => {
      const { loadSandbox, sandboxTool, ToolHost } = window.ToolSandbox;
      let open = false;
      const sent = [];
      const beacons = [];
      const host = new ToolHost({
        txGate: () => open,
        transmit: (t, info) => sent.push([t, info]),
        onBeacon: (t, spec) => beacons.push([t, spec]),
      });
      const perms = ["command", "monitor", "event", "panel", "map", "ipc", "tx", "beacon"];
      const sb = await loadSandbox(await (await fetch("/api-tool.js")).text(), perms);
      const manifest = {
        name: "api",
        title: "API",
        author: "X",
        version: "1",
        permissions: perms,
        surfaces: ["web", "terminal", "map"],
        remote: true,
      };
      host.register(sandboxTool(manifest, sb));
      host.setEnabled("api", true);
      const wait = async (cond) => {
        for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
        return cond();
      };
      const r = { remoteOff: sb.remoteOff, decoders: sb.decoders };
      await wait(() => host.ipcServices().includes("echo.upper"));
      r.firstPanel = host.panels("web")[0]?.spec.title;
      r.firstColour = host.colourisers("terminal")[0]?.({ src: "DL1ABC", dst: "", text: "" })?.colorVar;
      r.meta = await sb.runCommand("meta", "");
      r.decoded = await sb.decode("upper", "xyz");
      host.dispatch("on_frame", { peerCall: "OE8XBM-7", text: ">hi", source: "RF" });
      r.heard =
        (await wait(() => host.panels("web")[0]?.spec.title === "Heard")) && host.panels("web")[0].spec.nodes[0].text;
      const replies = [];
      host.dispatch("on_connect", { peerCall: "OE3ABC", reply: (t) => replies.push(t) });
      await wait(() => replies.length > 0);
      r.replies = replies;

      // A surface's connected sessions: on_connect/on_disconnect, the reply through the surface's gate, remote
      // commands only on incoming sessions, and the link topics.
      const lines = [];
      const logs = [];
      let sessionGate = null;
      const ev = new window.ToolSandbox.SessionEvents({
        host,
        surface: "terminal",
        send: (ch, text, tool) => lines.push([ch, text, tool].join("|")),
        txBlocked: () => sessionGate,
        runRemote: window.remoteRunner([{ manifest, sb }]),
        log: (m) => logs.push(m),
      });
      const sess = (channel, direction, open = true) => ({
        channel,
        peerCall: "OE3ABC",
        myCall: "OE8APR",
        direction,
        open,
      });
      ev.sync([sess(1, "incoming")]);
      await wait(() => lines.length > 0);
      ev.line(1, "PING");
      ev.line(1, "op");
      await wait(() => lines.length > 1);
      await new Promise((res) => setTimeout(res, 100));
      ev.sync([sess(1, "incoming"), sess(2, "outgoing")]);
      ev.line(2, "ping");
      sessionGate = "closed for the test";
      ev.sync([sess(1, "incoming"), sess(2, "outgoing"), sess(3, "incoming")]);
      await new Promise((res) => setTimeout(res, 100));
      ev.closeAll();
      await new Promise((res) => setTimeout(res, 50));
      r.sessionLines = lines;
      r.sessions = await sb.runCommand("sessions", "");
      const pings = [];
      const stopPings = host.hostSubscribe("link.ping.request", (d, from) => pings.push(from));
      const rttSeen = [];
      const stopRtt = host.hostSubscribe("link.rtt", (d) => rttSeen.push(d.ms));
      host.hostEmit("link.rtt", { ms: 420 });
      await wait(() => rttSeen.length > 0);
      await new Promise((res) => setTimeout(res, 50));
      r.rtt = await sb.runCommand("rtt", "");
      await sb.runCommand("pingreq", "");
      await wait(() => pings.length > 0);
      r.pings = pings;
      r.rttSeen = rttSeen;
      stopPings();
      stopRtt();
      r.later = await sb.runCommand("later", "x");
      r.txClosed = await sb.runCommand("tx", "");
      open = true;
      r.txOpen = await sb.runCommand("tx", "");
      r.txAgain = await sb.runCommand("tx", "");
      r.sent = sent;
      r.beacon = await sb.runCommand("beacon", "");
      r.beacons = beacons.slice();
      await sb.runCommand("wp", "");
      await wait(() => host.mapLayers().length > 0);
      r.layer = host.mapLayers()[0]?.spec;
      await sb.runCommand("colours", "");
      await wait(() => host.colourisers("terminal")[0]?.({ src: "OE8APR", dst: "", text: "" }));
      r.colour = host.colourisers("terminal")[0]?.({ src: "OE8APR", dst: "", text: "" })?.colorVar;
      r.ask = await sb.runCommand("ask", "");
      host.setEnabled("api", false);
      r.beaconsAfterOff = beacons.slice(-1);
      r.offTx = await sb.runCommand("tx", "");
      sb.destroy();

      const greedy = await loadSandbox(await (await fetch("/greedy.js")).text(), ["command"]);
      const gm = {
        name: "greedy",
        title: "Greedy",
        author: "X",
        version: "1",
        permissions: ["command"],
        surfaces: ["web", "map"],
      };
      host.register(sandboxTool(gm, greedy));
      host.setEnabled("greedy", true);
      r.greedy = await greedy.runCommand("reach", "");
      r.greedyLayers = host.mapLayers().length;
      greedy.destroy();
      return r;
    });
    console.log("the whole API", JSON.stringify(api));
    expect(
      api.remoteOff.includes("op") && !api.remoteOff.includes("ping"),
      "keeps a command from remote peers unless it opts in",
    );
    expect(api.firstPanel === "Contract" && api.firstColour === "--st-user", "registers a panel and colour rules");
    expect(
      api.meta[0] === '{"major":1,"minor":0}' && api.meta[1] === "true" && api.meta[2] === "false",
      "reads tool.api and asks tool.has() for features",
    );
    expect(
      api.decoded === "XYZ" && api.decoders[0]?.sample === "abc" && api.decoders[0]?.placeholder === "text",
      "runs an async decoder that declares a sample and a placeholder",
    );
    expect(api.heard === "OE8XBM-7 >hi", "hears frames with their text and sets its panel");
    expect(api.replies[0] === "Welcome OE3ABC", "answers a connected session through its reply");
    expect(api.later[0] === "later x", "awaits an async command");
    expect(
      api.sessions.slice(1).join(";") ===
        [
          "connect terminal 1 OE3ABC OE8APR incoming function",
          "connect terminal 2 OE3ABC OE8APR outgoing undefined",
          "connect terminal 3 OE3ABC OE8APR incoming function",
          "disconnect 1 OE3ABC undefined",
          "disconnect 2 OE3ABC undefined",
          "disconnect 3 OE3ABC undefined",
        ].join(";"),
      "hears on_connect and on_disconnect with the session's calls, channel, surface and direction",
    );
    expect(
      api.sessionLines.join(";") === "1|Welcome OE3ABC|api;1|pong|api",
      "replies and answers a remote command on an incoming session, never on an outgoing one or with the gate closed",
    );
    expect(api.rtt[0] === "420 (host)", "hears link.rtt from the app");
    expect(
      api.pings.join(",") === "api" && api.rttSeen.join(",") === "420",
      "publishes link.ping.request, and may not publish link.rtt",
    );
    expect(api.txClosed[0] === "false", "cannot transmit while the gate is closed");
    expect(api.txOpen[0] === "true" && api.sent.length === 1, "transmits once the gate opens");
    expect(api.txAgain[0] === "false", "is rate-limited right after a transmission");
    expect(api.sent[0]?.[0] === "api" && api.sent[0]?.[1] === ">from a tool", "transmits under its own name");
    expect(api.beacon[0] === "true" && api.beacons[0]?.[1]?.intervalSec === 600, "schedules a clamped beacon");
    expect(api.layer?.points?.[0]?.label === "home", "draws a map layer");
    expect(api.colour === "--warn", "colours the monitor by callsign");
    expect(api.ask[0] === "ABC", "calls a service it provides over the bus");
    expect(api.beaconsAfterOff[0]?.[1] === null, "switching it off ends its beacon");
    expect(/switched off/.test(api.offTx[0] ?? ""), "a switched-off tool cannot transmit");
    expect(api.greedy.join(",") === "refused,refused,refused", "a tool without the grants is refused in the worker");
    expect(api.greedyLayers === 0, "and contributes nothing to the host");

    // 2b. The signed tools from the bundled registry, unchanged, on a connected session of the terminal.
    const signed = await page.evaluate(async () => {
      const { loadSandbox, sandboxTool, ToolHost, SessionEvents } = window.ToolSandbox;
      const host = new ToolHost();
      const tools = [];
      for (const name of ["auto-responder", "connect-bell", "away-note", "info-responder", "link-ping"]) {
        const manifest = await (await fetch(`/bundled/${name}/tool.json`)).json();
        const sb = await loadSandbox(await (await fetch(`/bundled/${name}/tool.js`)).text(), manifest.permissions);
        host.register(sandboxTool(manifest, sb));
        host.setEnabled(name, true);
        tools.push({ manifest, sb });
      }
      const sbOf = (n) => tools.find((t) => t.manifest.name === n).sb;
      const wait = async (cond) => {
        for (let i = 0; i < 100 && !cond(); i++) await new Promise((res) => setTimeout(res, 20));
        return cond();
      };
      const settle = () => new Promise((res) => setTimeout(res, 150));
      await settle();
      const r = {};
      r.away = await sbOf("away-note").runCommand("away", "back at 18z");
      const lines = [];
      const ev = new SessionEvents({
        host,
        surface: "terminal",
        send: (ch, text, tool) => lines.push(`${tool}: ${text}`),
        txBlocked: () => null,
        runRemote: window.remoteRunner(tools),
      });
      ev.sync([{ channel: 1, peerCall: "OE3ABC", myCall: "OE8APR", direction: "incoming", open: true }]);
      await wait(() => lines.length >= 2);
      for (const l of ["INFO", "NOTE see you at 18z", "notes", "setinfo hijack"]) ev.line(1, l);
      await settle();
      await settle();
      r.lines = lines.slice();
      r.notes = await sbOf("away-note").runCommand("notes", "");
      const bellPanel = () => host.panels("terminal").find((p) => p.tool === "connect-bell")?.spec.nodes[0];
      await wait(() => bellPanel()?.kind === "kv");
      r.bell = bellPanel()?.value ?? "";
      const pings = [];
      host.hostSubscribe("link.ping.request", (d, from) => pings.push(from));
      r.ping = await sbOf("link-ping").runCommand("ping", "");
      await wait(() => pings.length > 0);
      r.pings = pings;
      host.hostEmit("link.rtt", { ms: 420, kind: "poll", peerCall: "OE3ABC", channel: 1, surface: "terminal" });
      const pingPanel = () => host.panels("terminal").find((p) => p.tool === "link-ping")?.spec.nodes[0];
      await wait(() => pingPanel()?.value === "420 ms");
      r.rtt = pingPanel()?.value;
      ev.closeAll();
      for (const t of tools) t.sb.destroy();
      return r;
    });
    console.log("the signed tools", JSON.stringify(signed));
    expect(
      signed.lines.slice(0, 2).sort().join(";") ===
        "auto-responder: Welcome OE3ABC - this is OE8APR auto-responder. Type H for help.;" +
          "away-note: back at 18z Leave a note with:  NOTE <text>",
      "auto-responder and away-note greet a station that connects",
    );
    expect(
      signed.lines.slice(2).join(";") ===
        "info-responder: APRScaching shack station. Type MENU for commands. 73!;away-note: Note saved - 73!",
      "a connected station runs INFO and NOTE, and not the operator's notes or setinfo",
    );
    expect(signed.notes.join(";") === "see you at 18z", "the note a station left reaches the operator");
    expect(/^OE3ABC/.test(signed.bell), "connect-bell rings for the station that connected");
    expect(signed.pings.join(",") === "link-ping", "link-ping's /ping asks the app for a ping");
    expect(signed.rtt === "420 ms", "link-ping shows the round trip the app publishes");

    const probe = (granted, connect) =>
      page.evaluate(
        async ([granted, connect, appOrigin]) => {
          const sb = await window.ToolSandbox.loadSandbox(await (await fetch("/probe.js")).text(), granted, {
            connect,
            appOrigins: [appOrigin],
          });
          for (let i = 0; i < 100; i++) {
            if ((await sb.runCommand("ready", ""))[0] === "10") break;
            await new Promise((r) => setTimeout(r, 100));
          }
          const out = JSON.parse((await sb.runCommand("probe", ""))[0]);
          sb.destroy();
          return out;
        },
        [granted, connect, appUrl],
      );

    // 3. Without the network grant.
    const closed = await probe(["command"], [peerUrl]);
    console.log("tool without the network grant", JSON.stringify(closed));
    for (const k of Object.keys(closed)) expect(closed[k] === "blocked", `${k} is blocked`);
    expect(peerHits.length === 0, "the peer saw no request");

    // 4. With the network grant and the peer listed in connect (the app's origin listed too, and dropped).
    const open = await probe(["command", "network"], [peerUrl, appUrl]);
    console.log("tool with the network grant", JSON.stringify(open));
    expect(open.fetchPeer === "reached: peer-ok", "reaches its connect origin");
    expect(
      peerHits.some((h) => h.url === "/peer-creds") && peerHits.every((h) => h.cookie === null),
      "a credentialed request to the peer carries no cookie",
    );
    expect(open.fetchApp === "blocked" && open.xhr === "blocked", "the app's own origin stays unreachable");
    for (const k of ["indexedDB", "caches", "localStorage", "cookie"])
      expect(open[k] === "blocked", `${k} is still blocked`);
    expect(appHits.length === 0, "the app server saw no request from a tool");
  } finally {
    await browser.close();
    app.close();
    peer.close();
  }

  if (failures.length) {
    console.error(`FAIL: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log(
    "PASS: tools run apart from the app's origin, storage and session, and reach the host only through their grants",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
