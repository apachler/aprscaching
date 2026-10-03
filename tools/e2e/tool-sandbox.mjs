// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * tool-sandbox.mjs — a headless Chromium end-to-end test for the imported-tool sandbox
 * (`apps/web/src/tools/sandbox.ts`). It bundles the real module, loads tools into it from a page that holds a
 * session cookie and an IndexedDB database, and asserts what a tool reaches:
 *
 *   1. the example hello tool loads, answers its command and runs its decoder;
 *   2. a tool without the network grant reaches no network (fetch, XHR, nested Worker, EventSource) and no
 *      app storage (IndexedDB, Cache Storage, localStorage, cookies);
 *   3. a tool with the network grant reaches its `connect` origin, without the page's cookie, and not the
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
    await attempt("fetchPeer", async () => (await fetch(${JSON.stringify(peerUrl + "/peer")}, { credentials: "include" })).text());
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

async function main() {
  const exe = findChromium();
  if (!exe) {
    console.log("SKIP: no Chromium available (set CHROMIUM_PATH or `npx playwright install chromium`)");
    process.exit(0);
  }

  const bundled = await build({
    entryPoints: [path.join(ROOT, "apps/web/src/tools/sandbox.ts")],
    bundle: true,
    format: "iife",
    globalName: "ToolSandbox",
    write: false,
    platform: "browser",
    target: "es2022",
  });
  const bundleJs = bundled.outputFiles[0].text;
  const helloJs = readFileSync(path.join(ROOT, "apps/web/public/tools/hello/tool.js"), "utf8");

  // The peer: a second origin a network-granted tool may reach. It records the cookie header it receives.
  const peerHits = [];
  const peer = createServer((req, res) => {
    peerHits.push({ url: req.url, cookie: req.headers.cookie ?? null });
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
    res.setHeader("access-control-allow-credentials", "true");
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
      const sb = await window.ToolSandbox.loadSandbox("/hello.js", ["command", "monitor", "panel", "decoder"]);
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

    const probe = (granted, connect) =>
      page.evaluate(
        async ([granted, connect, appOrigin]) => {
          const sb = await window.ToolSandbox.loadSandbox("/probe.js", granted, undefined, {
            connect,
            appOrigins: [appOrigin],
          });
          for (let i = 0; i < 100; i++) {
            if ((await sb.runCommand("ready", ""))[0] === "9") break;
            await new Promise((r) => setTimeout(r, 100));
          }
          const out = JSON.parse((await sb.runCommand("probe", ""))[0]);
          sb.destroy();
          return out;
        },
        [granted, connect, appUrl],
      );

    // 2. Without the network grant.
    const closed = await probe(["command"], [peerUrl]);
    console.log("tool without the network grant", JSON.stringify(closed));
    for (const k of Object.keys(closed)) expect(closed[k] === "blocked", `${k} is blocked`);
    expect(peerHits.length === 0, "the peer saw no request");

    // 3. With the network grant and the peer listed in connect (the app's origin listed too, and dropped).
    const open = await probe(["command", "network"], [peerUrl, appUrl]);
    console.log("tool with the network grant", JSON.stringify(open));
    expect(open.fetchPeer === "reached: peer-ok", "reaches its connect origin");
    expect(peerHits.length > 0 && peerHits.every((h) => h.cookie === null), "the peer request carries no cookie");
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
  console.log("PASS: imported tools run apart from the app's origin, storage and session");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
