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
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { handle, isGatewayPath } from "@aprscaching/gateway/app";
import { clientIp, stampClientIp } from "@aprscaching/gateway/corroborate_privacy";
import { proxyHops, type Env } from "@aprscaching/gateway/env";
import { PAGE_HEADERS } from "@aprscaching/gateway/pageheaders";
import { LIVE_MESSAGE_MAX_BYTES, type RoomsCore } from "@aprscaching/gateway/rooms-core";
import { joinRoom } from "./rooms.js";
import { SPA_NOT_FOUND_HEADERS, spaFile } from "./spa.js";
import { type BodyGate, bodyFailureResponse, meterBody, type MeteredBody, sharedBodyGate } from "./bodygate.js";
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
  /** The slots large request bodies take (bodygate.ts); every listener of the process shares one by default. */
  bodyGate?: BodyGate;
  /** How long a response write may wait for the client to take bytes before the connection is dropped. */
  writeStallMs?: number;
}

/**
 * A response write that waits this long for the client to take any bytes drops the connection. Node's idle
 * timeout never fires while a write is pending, so a client that requests a large answer and never reads would
 * otherwise hold it in the server for as long as it keeps the socket open.
 */
export const WRITE_STALL_MS = 30_000;
/** How long a connection closed under an unread body waits, after its answer, before it is reset. */
const LINGER_MS = 2_000;
/** Response bodies are written in slices of this size, so a slow but reading client shows progress per slice. */
const WRITE_SLICE = 64 * 1024;

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
  if (proxyHops(env) && forwarded === "https") return null;
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIVE_MESSAGE_MAX_BYTES });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    // Node applies no server timeouts to a socket once it is upgraded, so every path out of here either
    // hands the socket to `ws` or closes it. The path and query alone route /ws: the Host header, which Node
    // does not validate, plays no part.
    let u: URL;
    let holder: string;
    try {
      u = new URL(req.url ?? "/", "http://localhost");
      holder = clientIp(new Request(u, { headers: clientHeaders(req, opts.env) }), opts.env);
    } catch {
      refuseUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (u.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const admitted = opts.rooms.admit(u, holder);
    if ("status" in admitted) {
      refuseUpgrade(socket, admitted.status, admitted.status === 429 ? "Too Many Requests" : "Bad Request");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => joinRoom(opts.rooms, admitted.region, ws, holder));
  });
  return server;
}

function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  const retry = status === 429 ? "Retry-After: 60\r\n" : "";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n${retry}Content-Length: 0\r\n\r\n`);
}

/** A request's headers as Web Headers, with the client identity stamped from its socket (stampClientIp). */
function clientHeaders(nreq: http.IncomingMessage, env: Env): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(nreq.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, v);
  }
  // The socket address is the ONLY client identity we mint ourselves — overwrite any client-supplied
  // x-real-ip, and drop a client-sent cf-connecting-ip unless a Cloudflare edge is declared (TRUST_CF).
  stampClientIp(headers, nreq.socket.remoteAddress, env);
  return headers;
}

async function serveRequest(
  opts: ListenerOptions,
  scheme: "http" | "https",
  nreq: http.IncomingMessage,
  nres: http.ServerResponse,
): Promise<void> {
  const { env } = opts;
  let body: MeteredBody | undefined;
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
    const headers = clientHeaders(nreq, env);
    const hasBody = method !== "GET" && method !== "HEAD";
    // The body goes to the gateway unread: the handler pulls it after routing and its own checks, metered
    // against the body slots (bodygate.ts). Raw bytes — the federation wire is binary (CBOR sync pages, beacon
    // datagrams), so nothing here decodes it.
    if (hasBody)
      body = meterBody(
        nreq.iterator({ destroyOnReturn: false }),
        clientIp(new Request(url, { headers }), env),
        opts.bodyGate ?? sharedBodyGate,
      );
    // the slot goes back when the answer is done or the connection goes, whatever the handler read
    if (body) {
      nres.once("finish", body.finish);
      nres.once("close", body.finish);
    }
    const request = new Request(url, {
      method,
      headers,
      ...(body ? { body: body.stream, duplex: "half" } : {}),
    } as RequestInit);
    // The client may leave while the handler runs, and `close` does not fire again for a listener added later: a
    // body it can no longer be sent is cancelled here, since a tile answer's body holds an open archive copy.
    let gone = false;
    nres.once("close", () => (gone = true));
    let response = await handle(request, env, { waitUntil: (p) => void p.catch(() => {}) });
    if (gone) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    const failure = body?.failure();
    if (failure) response = bodyFailureResponse(failure);
    const stall = opts.writeStallMs ?? WRITE_STALL_MS;

    nres.statusCode = response.status;
    response.headers.forEach((value, key) => nres.setHeader(key, value));
    // A body the handler left unread is not drained: the connection closes under its rest. The server sends its
    // end first and resets only a moment later, so the client still reads the answer: a reset that meets the
    // client while it is sending discards what it had received.
    if (!nreq.complete) {
      nres.setHeader("connection", "close");
      nres.once("finish", () => {
        const sock = nreq.socket;
        sock.end();
        setTimeout(() => sock.destroy(), LINGER_MS).unref();
      });
    }
    const type = response.headers.get("content-type") ?? "";
    if (response.body && (type.includes("text/event-stream") || response.headers.has("content-length"))) {
      // An event stream (the CoT push feed) is long-lived, and a body of a declared length (a tile range) may be
      // read lazily by its handler: both are piped chunk by chunk, as the client takes them.
      if (type.includes("text/event-stream")) nreq.socket.setTimeout(0); // no idle timeout on a streaming connection
      const reader = response.body.getReader();
      nres.on("close", () => void reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(await writeSlices(nres, value, stall))) {
          // a stall drop or a client gone: the rest is never sent, so the source is released now
          await reader.cancel().catch(() => {});
          return;
        }
      }
      nres.end();
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length <= WRITE_SLICE) nres.end(buf);
      else {
        nres.setHeader("content-length", buf.length);
        if (await writeSlices(nres, buf, stall)) nres.end();
      }
    }
  } catch (e) {
    // handle() answers its own failures; this catches the bridge's (a client gone mid-stream). Nothing about
    // the failure reaches the client.
    console.error("%s %s:", nreq.method ?? "?", nreq.url ?? "?", e);
    if (nres.headersSent) {
      nres.destroy();
      return;
    }
    nres.statusCode = 500;
    nres.setHeader("content-type", "application/json");
    nres.end(JSON.stringify({ error: "internal error" }));
  }
}

/**
 * Write `bytes` in slices, waiting after each one the socket does not take at once for it to drain. A wait
 * longer than `stallMs` destroys the connection — the client stopped reading — and answers false, as does a
 * connection that closed meanwhile.
 */
async function writeSlices(nres: http.ServerResponse, bytes: Uint8Array, stallMs: number): Promise<boolean> {
  for (let at = 0; at < bytes.length; at += WRITE_SLICE) {
    if (nres.destroyed) return false;
    if (nres.write(bytes.subarray(at, at + WRITE_SLICE))) continue;
    const drained = await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        nres.off("drain", onDrain);
        nres.off("close", onClose);
        resolve(ok);
      };
      const onDrain = () => done(true);
      const onClose = () => done(false);
      const timer = setTimeout(() => done(false), stallMs);
      nres.once("drain", onDrain);
      nres.once("close", onClose);
    });
    if (!drained) {
      nres.destroy();
      return false;
    }
  }
  return true;
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
    nres.writeHead(404, { ...SPA_NOT_FOUND_HEADERS }).end("not found");
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(f.file);
  } catch {
    nres.writeHead(404, { ...SPA_NOT_FOUND_HEADERS }).end("not found");
    return;
  }
  const { encoding, vary } = negotiate(f.contentType, stat.size, {
    acceptEncoding: headers["accept-encoding"],
    range: headers.range,
  });
  nres.statusCode = 200;
  nres.setHeader("content-type", f.contentType);
  nres.setHeader("cache-control", f.cacheControl);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) nres.setHeader(k, v);
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
