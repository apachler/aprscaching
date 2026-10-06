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
 *      service it provides on the bus; a tool without a grant is refused;
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

// A tool that uses every part of the API its grants allow.
const apiTool = `
  tool.on("on_frame", (p) => tool.setPanel({ title: "Heard", nodes: [{ kind: "text", text: p.peerCall + " " + (p.text || "") }] }));
  tool.on("on_connect", (p) => { if (p.reply) p.reply("Welcome " + p.peerCall); });
  tool.provide("echo.upper", async (a) => String(a).toUpperCase());
  register({ commands: {
    later: async (a) => { await new Promise((r) => setTimeout(r, 20)); return ["later " + a]; },
    tx: async () => [String(await tool.requestTx(">from a tool"))],
    beacon: async () => { try { return [String(await tool.scheduleBeacon({ comment: "QRV", intervalSec: 60 }))]; } catch (e) { return ["refused: " + e.message]; } },
    wp: () => { tool.setMapLayer({ id: "wp", points: [{ lat: 47, lon: 15, label: "home" }] }); return ["ok"]; },
    colours: () => { tool.setColourRules([{ src: "OE8APR", colorVar: "--warn" }]); return ["ok"]; },
    ask: async () => [String(await tool.call("echo.upper", "abc"))],
    op: () => ["operator only"],
    ping: { run: () => ["pong"], remote: true },
  } });
`;
// A tool that reaches for what it was not granted.
const greedyTool = `
  const tryIt = (fn) => { try { fn(); return "allowed"; } catch (e) { return "refused"; } };
  register({ commands: {
    reach: () => [tryIt(() => tool.setMapLayer({ id: "x", points: [] })), tryIt(() => tool.on("on_frame", () => {})), tryIt(() => tool.requestTx(">x"))],
  } });
`;

async function main() {
  const exe = findChromium();
  if (!exe) {
    console.log("SKIP: no Chromium available (set CHROMIUM_PATH or `npx playwright install chromium`)");
    process.exit(0);
  }

  const bundled = await build({
    stdin: {
      contents: `export { loadSandbox, sandboxTool } from "./apps/web/src/tools/sandbox.ts";
        export { ToolHost } from "./packages/tools/src/index.ts";`,
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
  const HTML = `<!doctype html><meta charset=utf-8><title>tool-sandbox-e2e</title><script src="/bundle.js"></script>`;
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
      };
      host.register(sandboxTool(manifest, sb));
      host.setEnabled("api", true);
      const wait = async (cond) => {
        for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
        return cond();
      };
      const r = { remoteOff: sb.remoteOff };
      await wait(() => host.ipcServices().includes("echo.upper"));
      host.dispatch("on_frame", { peerCall: "OE8XBM-7", text: ">hi", source: "RF" });
      r.heard = (await wait(() => host.panels("web")[0])) && host.panels("web")[0].spec.nodes[0].text;
      const replies = [];
      host.dispatch("on_connect", { peerCall: "OE3ABC", reply: (t) => replies.push(t) });
      await wait(() => replies.length > 0);
      r.replies = replies;
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
    expect(api.heard === "OE8XBM-7 >hi", "hears frames with their text and sets its panel");
    expect(api.replies[0] === "Welcome OE3ABC", "answers a connected session through its reply");
    expect(api.later[0] === "later x", "awaits an async command");
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
