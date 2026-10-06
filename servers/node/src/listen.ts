// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Node server's listeners: a node:http ↔ Web Request/Response bridge to the runtime-neutral handle(),
 * the built SPA (WEB_DIST), the live-room WebSocket upgrade, and — for a station whose visitors reach it on
 * a Wi-Fi hotspot — an optional https listener beside the plain one.
 *
 * Both listeners run the same handler and the same /ws upgrade; each builds request URLs with its own
 * scheme, so links the gateway derives from a request (gatewayBase, the sign-in confirm step) say https to
 * an https visitor. With an https listener running, the plain one moves other devices' page loads to it
 * (httpsRedirect); loopback, API, ingest and federation calls are served where they arrive. TLS_CA_CERT,
 * when set, is served at one fixed path on both, so a visitor can fetch the station's CA before trusting it.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { WebSocketServer } from "ws";
import { handle, isGatewayPath } from "@aprscaching/gateway/app";
import { stampClientIp } from "@aprscaching/gateway/corroborate_privacy";
import type { Env } from "@aprscaching/gateway/env";
import { liveRegionOf } from "@aprscaching/gateway/live";
import type { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { joinRoom } from "./rooms.js";
import { spaFile } from "./spa.js";
import { BODY_MAX_BYTES } from "./host.js";
import { compressed, negotiate } from "./compress.js";

/** The one path TLS_CA_CERT is served at. No other path ever reads a file named by configuration. */
const CA_CERT_PATH = "/pocket-ca.crt";

export interface ListenerOptions {
  env: Env;
  rooms: RoomsCore;
  /** The built SPA (WEB_DIST), served for every path the gateway does not claim. */
  webDist?: string;
  /** The station CA certificate file (TLS_CA_CERT), served at /pocket-ca.crt. */
  caCert?: string;
  /** On the plain listener: the port of the https listener beside it, where page loads from other devices move. */
  httpsPort?: number;
  /** The certificate and key: present, the server speaks https. */
  tls?: TlsPair;
}

export interface TlsFiles {
  cert: string;
  key: string;
}
export interface TlsPair {
  cert: Buffer;
  key: Buffer;
}

/**
 * HTTPS_PORT with TLS_CERT and TLS_KEY: the https listener's port and files, null while HTTPS_PORT is
 * unset, or an error for a half-configured listener, which must stop the boot rather than serve plain http
 * only.
 */
export function tlsFromEnv(
  src: Record<string, string | undefined>,
): { ok: true; tls: (TlsFiles & { port: number }) | null } | { ok: false; error: string } {
  const raw = src.HTTPS_PORT?.trim();
  if (!raw) return { ok: true, tls: null };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { ok: false, error: `HTTPS_PORT must be a port number (1–65535), not "${raw}"` };
  const cert = src.TLS_CERT?.trim();
  const key = src.TLS_KEY?.trim();
  if (!cert || !key) return { ok: false, error: "HTTPS_PORT needs TLS_CERT and TLS_KEY (PEM files)" };
  return { ok: true, tls: { port, cert, key } };
}

/** Read the certificate (with its chain, as the file holds it) and the key. Throws when either is unreadable. */
export function readTls(files: TlsFiles): TlsPair {
  return { cert: fs.readFileSync(files.cert), key: fs.readFileSync(files.key) };
}

/** Load a re-issued certificate into a running https listener: new connections present it, open ones keep theirs. */
export function reloadTls(server: https.Server, files: TlsFiles): void {
  server.setSecureContext(readTls(files));
}

const isLoopback = (addr: string | undefined): boolean => !!addr && (addr === "::1" || /^(?:::ffff:)?127\./.test(addr));

/**
 * Where the plain listener sends a request when an https listener runs on `httpsPort`: the same host and
 * path on https, for a page load (GET accepting HTML) of an SPA route from another device. Null for
 * loopback (the owner's own browser on localhost), for every gateway path (API, auth, ingest, federation,
 * the live socket), for the CA download (fetched before the certificate is trusted), and for a request a
 * declared TLS-terminating proxy already carried over https.
 */
export function httpsRedirect(
  req: { method?: string; url?: string; headers: http.IncomingHttpHeaders; remoteAddress?: string },
  httpsPort: number,
  env: Env,
): string | null {
  if (req.method !== "GET" || isLoopback(req.remoteAddress)) return null;
  if (!String(req.headers.accept ?? "").includes("text/html")) return null;
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim();
  if (env.TRUST_PROXY === "1" && forwarded === "https") return null;
  const host = req.headers.host;
  if (!host) return null;
  let u: URL;
  try {
    u = new URL(req.url ?? "/", `http://${host}`);
  } catch {
    return null;
  }
  if (isGatewayPath(u.pathname) || u.pathname === CA_CERT_PATH) return null;
  return `https://${u.hostname}:${httpsPort}${u.pathname}${u.search}`;
}

/** The gateway on node:http (or node:https with `tls`), with the /ws live-room upgrade attached. */
export function createGatewayServer(opts: ListenerOptions): http.Server {
  const scheme = opts.tls ? "https" : "http";
  const listener: http.RequestListener = (nreq, nres) => void serveRequest(opts, scheme, nreq, nres);
  const server = opts.tls
    ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, listener)
    : http.createServer(listener);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", `${scheme}://${req.headers.host ?? "localhost"}`);
    if (u.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const region = liveRegionOf(u);
    if (!region) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => joinRoom(opts.rooms, region, ws));
  });
  return server;
}

async function serveRequest(
  opts: ListenerOptions,
  scheme: "http" | "https",
  nreq: http.IncomingMessage,
  nres: http.ServerResponse,
): Promise<void> {
  const { env } = opts;
  try {
    const url = `${scheme}://${nreq.headers.host ?? "localhost"}${nreq.url ?? "/"}`;
    const method = nreq.method ?? "GET";
    if (method === "GET" || method === "HEAD") {
      const pathname = new URL(url).pathname;
      if (opts.caCert && pathname === CA_CERT_PATH) {
        sendCaCert(nres, opts.caCert, method);
        return;
      }
      if (opts.httpsPort && scheme === "http") {
        const to = httpsRedirect(
          { method, url: nreq.url, headers: nreq.headers, remoteAddress: nreq.socket.remoteAddress },
          opts.httpsPort,
          env,
        );
        if (to) {
          nres.writeHead(302, { location: to, "cache-control": "no-store" }).end();
          return;
        }
      }
      if (opts.webDist && !isGatewayPath(pathname)) {
        await sendSpa(nres, spaFile(opts.webDist, pathname), method, nreq.headers);
        return;
      }
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v != null) headers.set(k, v);
    }
    // The socket address is the ONLY client identity we mint ourselves — overwrite any client-supplied
    // x-real-ip, and drop a client-sent cf-connecting-ip unless a Cloudflare edge is declared (TRUST_CF).
    stampClientIp(headers, nreq.socket.remoteAddress, env);
    const hasBody = method !== "GET" && method !== "HEAD";
    // readBody returns raw bytes — the gateway speaks JSON on most routes but BINARY on the
    // federation wire (CBOR sync pages, beacon datagrams); a utf8 round-trip would corrupt those.
    const request = new Request(url, { method, headers, body: hasBody ? await readBody(nreq) : undefined });
    const response = await handle(request, env, { waitUntil: (p) => void p.catch(() => {}) });

    nres.statusCode = response.status;
    response.headers.forEach((value, key) => nres.setHeader(key, value));
    // Server-Sent Events (the CoT push feed) are long-lived — pipe the body chunk-by-chunk instead
    // of buffering to completion (which would hold every event until the stream closed, defeating SSE).
    if (response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      nreq.socket.setTimeout(0); // no idle timeout on a streaming connection
      const reader = response.body.getReader();
      nres.on("close", () => void reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!nres.write(Buffer.from(value))) await new Promise((r) => nres.once("drain", r));
      }
      nres.end();
    } else {
      nres.end(Buffer.from(await response.arrayBuffer()));
    }
  } catch (e) {
    // handle() answers its own failures; this catches the bridge's (an oversized or broken body, a client gone
    // mid-stream). The client learns the size limit and nothing else.
    if (!(e instanceof BodyTooLarge)) console.error("%s %s:", nreq.method ?? "?", nreq.url ?? "?", e);
    if (nres.headersSent) {
      nres.destroy();
      return;
    }
    nres.statusCode = e instanceof BodyTooLarge ? 413 : 500;
    nres.setHeader("content-type", "application/json");
    if (e instanceof BodyTooLarge) {
      // the rest of the body is never read: answer, then close the connection under it
      nres.setHeader("connection", "close");
      nres.once("finish", () => nreq.socket.destroy());
    }
    nres.end(JSON.stringify({ error: e instanceof BodyTooLarge ? e.message : "internal error" }));
  }
}

/** The station's CA certificate, read on each request so a re-created CA is served without a restart. */
function sendCaCert(nres: http.ServerResponse, file: string, method: string): void {
  fs.readFile(file, (err, body) => {
    if (err) {
      nres.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    nres.writeHead(200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": 'attachment; filename="pocket-ca.crt"',
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    nres.end(method === "HEAD" ? undefined : body);
  });
}

/**
 * One file of the built SPA, or a 404 when nothing in the build answers the path. A text asset goes out
 * brotli- or gzip-compressed when the request accepts it (compress.ts); the cache and type headers are the
 * same either way.
 */
async function sendSpa(
  nres: http.ServerResponse,
  f: ReturnType<typeof spaFile>,
  method: string,
  headers: http.IncomingHttpHeaders,
): Promise<void> {
  if (!f) {
    nres.statusCode = 404;
    nres.setHeader("content-type", "text/plain; charset=utf-8");
    nres.end("not found");
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(f.file);
  } catch {
    nres.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  const { encoding, vary } = negotiate(f.contentType, stat.size, {
    acceptEncoding: headers["accept-encoding"],
    range: headers.range,
  });
  nres.statusCode = 200;
  nres.setHeader("content-type", f.contentType);
  nres.setHeader("cache-control", f.cacheControl);
  nres.setHeader("x-content-type-options", "nosniff");
  if (vary) nres.setHeader("vary", "Accept-Encoding");
  if (encoding) {
    const body = await compressed(`${f.file}\0${stat.size}\0${stat.mtimeMs}`, encoding, () =>
      fs.promises.readFile(f.file),
    );
    nres.setHeader("content-encoding", encoding);
    nres.setHeader("content-length", body.length);
    nres.end(method === "HEAD" ? undefined : body);
    return;
  }
  if (method === "HEAD") {
    nres.end();
    return;
  }
  fs.createReadStream(f.file)
    .on("error", () => nres.destroy())
    .pipe(nres);
}

/** The bridge buffers the whole body BEFORE routing/auth, so it stops at BODY_MAX_BYTES (host.ts): past it
 *  reading stops, the request is answered 413 and the connection closed. */
class BodyTooLarge extends Error {
  constructor() {
    super("request body too large");
  }
}
function readBody(req: http.IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c) => {
      total += (c as Buffer).length;
      if (total > BODY_MAX_BYTES) {
        req.removeAllListeners("data");
        req.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c as Buffer);
    });
    req.on("end", () => resolve(Uint8Array.from(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}
