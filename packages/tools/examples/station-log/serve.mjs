#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Serve this folder over HTTP with an open CORS header, so a local web app can import the tool from
// http://127.0.0.1:8790/tool.json. The app's page fetches the manifest and the script cross-origin, and the
// browser hands a response over only when the server allows the page's origin.
//
//   node serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? 8790);
const types = { ".json": "application/json", ".js": "text/javascript" };

createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^[/\\]+/, "");
  const type = types[extname(path)];
  if (!type || path.startsWith("..")) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  try {
    const body = await readFile(join(root, path));
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "no-store");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} at http://127.0.0.1:${port}/tool.json`));
