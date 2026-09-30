// SPDX-License-Identifier: AGPL-3.0-or-later
// The optional https listener of the Node server (HTTPS_PORT with TLS_CERT/TLS_KEY), for a station whose
// visitors reach it on a Wi-Fi hotspot: the same handler and live rooms as the plain listener, request
// URLs that say https, a certificate reload without a restart, the station's CA certificate at one fixed
// path, and a redirect of other devices' page loads from the plain port to the https one.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import type { Env } from "@aprscaching/gateway/env";
import { instanceEnv } from "./helpers/fedpeer.js";
import { hasOpenssl, makePki, type TestPki } from "./helpers/tls.js";
import { roomNamespace } from "../src/host.js";
import {
  createGatewayServer,
  httpsRedirect,
  readTls,
  reloadTls,
  tlsFromEnv,
  type ListenerOptions,
} from "../src/listen.js";

const open: Array<http.Server> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await new Promise((r) => s.close(r)).catch(() => {});
});

function stationEnv(extra: Record<string, unknown> = {}): Env {
  const rooms = new RoomsCore();
  return instanceEnv("localhost", null, { APP_URL: "http://localhost:8787", ROOMS: roomNamespace(rooms), ...extra });
}

function webDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-web-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>spa</title>");
  return dir;
}

async function start(opts: Omit<ListenerOptions, "rooms" | "tls"> & { tls?: TestPki }, host = "127.0.0.1") {
  const server = createGatewayServer({
    rooms: new RoomsCore(),
    ...opts,
    tls: opts.tls ? readTls({ cert: opts.tls.cert, key: opts.tls.key }) : undefined,
  });
  open.push(server);
  await new Promise<void>((r) => server.listen(0, host, r));
  return (server.address() as AddressInfo).port;
}

interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function get(url: string, opts: { ca?: string; headers?: Record<string, string> } = {}): Promise<Got> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      { headers: opts.headers, ca: opts.ca ? fs.readFileSync(opts.ca) : undefined, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The leaf certificate a TLS client is shown. */
function peerFingerprint(port: number, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port, path: "/health", ca: fs.readFileSync(ca), agent: false },
      (res) => {
        resolve((res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256);
        res.resume();
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** An address of this host another device would use: the first non-internal IPv4. */
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

describe("tlsFromEnv", () => {
  it("is off without HTTPS_PORT", () => {
    expect(tlsFromEnv({})).toEqual({ ok: true, tls: null });
    expect(tlsFromEnv({ HTTPS_PORT: "", TLS_CERT: "/c", TLS_KEY: "/k" })).toEqual({ ok: true, tls: null });
  });

  it("refuses HTTPS_PORT without both TLS_CERT and TLS_KEY, or a port that is not one", () => {
    expect(tlsFromEnv({ HTTPS_PORT: "8443" }).ok).toBe(false);
    expect(tlsFromEnv({ HTTPS_PORT: "8443", TLS_CERT: "/c" }).ok).toBe(false);
    expect(tlsFromEnv({ HTTPS_PORT: "0", TLS_CERT: "/c", TLS_KEY: "/k" }).ok).toBe(false);
    expect(tlsFromEnv({ HTTPS_PORT: "x", TLS_CERT: "/c", TLS_KEY: "/k" }).ok).toBe(false);
    expect(tlsFromEnv({ HTTPS_PORT: "70000", TLS_CERT: "/c", TLS_KEY: "/k" }).ok).toBe(false);
  });

  it("names the port and the files", () => {
    expect(tlsFromEnv({ HTTPS_PORT: "8443", TLS_CERT: "/c", TLS_KEY: "/k", TLS_CA_CERT: "/ca" })).toEqual({
      ok: true,
      tls: { port: 8443, cert: "/c", key: "/k" },
    });
  });
});

describe.skipIf(!hasOpenssl)("the https listener", () => {
  it("serves /health and the SPA over TLS", async () => {
    const pki = makePki(["127.0.0.1"]);
    const port = await start({ env: stationEnv(), webDist: webDist(), tls: pki });
    const health = await get(`https://127.0.0.1:${port}/health`, { ca: pki.caCert });
    expect(health.status).toBe(200);
    const spa = await get(`https://127.0.0.1:${port}/settings`, { ca: pki.caCert, headers: { accept: "text/html" } });
    expect(spa.status).toBe(200);
    expect(spa.body).toContain("<title>spa</title>");
  });

  it("builds https request URLs, and the plain listener http ones", async () => {
    const pki = makePki(["127.0.0.1"]);
    const env = stationEnv();
    const tlsPort = await start({ env, tls: pki });
    const plainPort = await start({ env });
    const secure = await get(`https://127.0.0.1:${tlsPort}/robots.txt`, { ca: pki.caCert });
    expect(secure.body).toContain(`Sitemap: https://127.0.0.1:${tlsPort}/sitemap.xml`);
    const plain = await get(`http://127.0.0.1:${plainPort}/robots.txt`);
    expect(plain.body).toContain(`Sitemap: http://127.0.0.1:${plainPort}/sitemap.xml`);
    // a forwarded scheme never lowers a request that arrived over TLS
    const spoofed = await get(`https://127.0.0.1:${tlsPort}/robots.txt`, {
      ca: pki.caCert,
      headers: { "x-forwarded-proto": "http" },
    });
    expect(spoofed.body).toContain(`Sitemap: https://127.0.0.1:${tlsPort}/`);
  });

  it("upgrades /ws to a live-room WebSocket over TLS", async () => {
    const pki = makePki(["127.0.0.1"]);
    const port = await start({ env: stationEnv(), tls: pki });
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws?region=global`, { ca: fs.readFileSync(pki.caCert) });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.close();
  });

  it("reloads the certificate without a restart", async () => {
    const pki = makePki(["127.0.0.1"]);
    const server = createGatewayServer({
      env: stationEnv(),
      rooms: new RoomsCore(),
      tls: readTls({ cert: pki.cert, key: pki.key }),
    });
    open.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const before = await peerFingerprint(port, pki.caCert);
    const next = makePki(["127.0.0.1"], pki.dir, "next");
    fs.copyFileSync(next.cert, pki.cert);
    fs.copyFileSync(next.key, pki.key);
    reloadTls(server as https.Server, { cert: pki.cert, key: pki.key });
    const after = await peerFingerprint(port, pki.caCert);
    expect(after).not.toBe(before);
  });
});

describe("/pocket-ca.crt", () => {
  const caFile = () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acs-ca-")), "ca.crt");
    fs.writeFileSync(f, "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n");
    return f;
  };

  it("serves TLS_CA_CERT read-only over plain http, with the CA certificate type", async () => {
    const ca = caFile();
    const port = await start({ env: stationEnv(), webDist: webDist(), caCert: ca, httpsPort: 8443 });
    const r = await get(`http://127.0.0.1:${port}/pocket-ca.crt`, { headers: { accept: "text/html" } });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/x-x509-ca-cert");
    expect(r.body).toBe(fs.readFileSync(ca, "utf8"));
  });

  it("is absent when TLS_CA_CERT is unset", async () => {
    const port = await start({ env: stationEnv(), webDist: webDist() });
    expect((await get(`http://127.0.0.1:${port}/pocket-ca.crt`)).status).toBe(404);
    const bare = await start({ env: stationEnv() });
    expect((await get(`http://127.0.0.1:${bare}/pocket-ca.crt`)).status).toBe(404);
  });

  it("serves only that one path, never another file", async () => {
    const ca = caFile();
    const port = await start({ env: stationEnv(), caCert: ca });
    for (const p of ["/pocket-ca.crt/", "/pocket-ca.key", "/ca.crt", "/pocket-ca.crt/../ca.crt", "/POCKET-CA.CRT"]) {
      const r = await get(`http://127.0.0.1:${port}${p}`);
      expect(r.body, p).not.toContain("synthetic");
    }
    expect(
      (await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/pocket-ca.crt", method: "POST" }, (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        });
        req.on("error", reject);
        req.end();
      })) !== 200,
    ).toBe(true);
  });
});

describe("httpsRedirect", () => {
  const env = stationEnv();
  const nav = (over: Partial<Parameters<typeof httpsRedirect>[0]> = {}) =>
    httpsRedirect(
      {
        method: "GET",
        url: "/cache/AC1?x=1",
        headers: { host: "192.168.43.1:8787", accept: "text/html,application/xhtml+xml" },
        remoteAddress: "192.168.43.77",
        ...over,
      },
      8443,
      env,
    );

  it("moves another device's page load to the https port on the same host", () => {
    expect(nav()).toBe("https://192.168.43.1:8443/cache/AC1?x=1");
    expect(nav({ remoteAddress: "::ffff:192.168.43.77" })).toBe("https://192.168.43.1:8443/cache/AC1?x=1");
  });

  it("never redirects loopback, so localhost keeps working for the owner", () => {
    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.8.9.10"])
      expect(nav({ remoteAddress }), remoteAddress).toBeNull();
  });

  it("never redirects API, ingest or federation calls, the CA download, or a non-page request", () => {
    for (const url of [
      "/api/caches",
      "/ingest",
      "/federation/sync",
      "/auth/session",
      "/ws",
      "/health",
      "/pocket-ca.crt",
    ])
      expect(nav({ url }), url).toBeNull();
    expect(nav({ method: "POST" })).toBeNull();
    expect(nav({ method: "HEAD" })).toBeNull();
    expect(nav({ headers: { host: "192.168.43.1:8787", accept: "application/json" } })).toBeNull();
    expect(nav({ headers: { host: "192.168.43.1:8787" } })).toBeNull();
    expect(nav({ headers: { accept: "text/html" } })).toBeNull(); // no Host to redirect to
  });

  it("leaves a request a TLS-terminating proxy already carried over https", () => {
    const proxied = { host: "192.168.43.1:8787", accept: "text/html", "x-forwarded-proto": "https" };
    expect(
      httpsRedirect(
        { method: "GET", url: "/", headers: proxied, remoteAddress: "10.0.0.2" },
        8443,
        stationEnv({ TRUST_PROXY: "1" }),
      ),
    ).toBeNull();
    // without a declared proxy the header is anyone's to send
    expect(httpsRedirect({ method: "GET", url: "/", headers: proxied, remoteAddress: "10.0.0.2" }, 8443, env)).toBe(
      "https://192.168.43.1:8443/",
    );
  });

  it("keeps an IPv6 host bracketed", () => {
    expect(nav({ headers: { host: "[fd00::1]:8787", accept: "text/html" } })).toBe(
      "https://[fd00::1]:8443/cache/AC1?x=1",
    );
  });
});

describe.skipIf(!lanAddress)("the plain listener beside an https one", () => {
  it("redirects a page load from another device, and serves loopback and the API as they are", async () => {
    const port = await start({ env: stationEnv(), webDist: webDist(), httpsPort: 8443 }, "0.0.0.0");
    const page = await get(`http://${lanAddress}:${port}/map`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe(`https://${lanAddress}:8443/map`);
    const api = await get(`http://${lanAddress}:${port}/health`, { headers: { accept: "text/html" } });
    expect(api.status).toBe(200);
    const local = await get(`http://127.0.0.1:${port}/map`, { headers: { accept: "text/html" } });
    expect(local.status).toBe(200);
    expect(local.body).toContain("<title>spa</title>");
  });

  it("redirects nothing while no https listener runs", async () => {
    const port = await start({ env: stationEnv(), webDist: webDist() }, "0.0.0.0");
    expect((await get(`http://${lanAddress}:${port}/map`, { headers: { accept: "text/html" } })).status).toBe(200);
  });
});
