// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * unixfetch.ts — fetch over a Unix socket, for the gateway's GATEWAY_SOCKET. The URL gives the request its
 * path, query and Host header; the bytes go through the socket file and never to the URL's host and port.
 * Node's own fetch dials only TCP.
 */
import http from "node:http";

function bodyBytes(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("a request over the gateway's socket needs a string or byte body");
}

/** Statuses whose Response carries no body. */
const NULL_BODY = new Set([204, 205, 304]);

/** `fetch(url, init)` through the socket at `socketPath`. Rejects on a socket error or the init's signal. */
export function unixFetch(socketPath: string, url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url);
  const headers: Record<string, string> = { host: u.host };
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const body = bodyBytes(init.body);
  if (body) headers["content-length"] = String(body.length);
  const signal = init.signal ?? undefined;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const req = http.request({ socketPath, path: u.pathname + u.search, method: init.method ?? "GET", headers });
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);
    req.on("error", (e) => {
      done();
      reject(e);
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", (e) => {
        done();
        reject(e);
      });
      res.on("end", () => {
        done();
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
          else if (v != null) h.set(k, v);
        }
        const status = res.statusCode ?? 502;
        resolve(
          new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), {
            status,
            statusText: res.statusMessage,
            headers: h,
          }),
        );
      });
    });
    req.end(body);
  });
}
