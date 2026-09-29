// SPDX-License-Identifier: AGPL-3.0-or-later
// Drive the real auth endpoints of `handle()` over a migrated SQLite: email magic-link sign-up with
// in-band dev tokens, and passkey register/login with a software P-256 authenticator ("none"
// attestation), so tests exercise the same ceremony a browser runs.
import type { Env } from "@aprscaching/gateway/env";
import { instanceEnv, serve } from "./fedpeer.js";

export const ORIGIN = "https://gw.test";
export const RP_ID = "gw.test";
const enc = new TextEncoder();

/** An instance with dev tokens and passkeys configured. */
export function authEnv(extra: Record<string, unknown> = {}, db?: unknown): Env {
  return instanceEnv("gw.test", null, { ALLOW_DEV_TOKENS: "1", APP_URL: ORIGIN, RP_ID, ...extra }, db);
}

export interface Res {
  status: number;
  data: any;
  cookie: string;
}

/** One JSON request against the gateway. `ip` is the socket address the runtime would stamp. */
export async function call(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  ip = "192.0.2.10",
): Promise<Res> {
  const res = await serve(env)(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-real-ip": ip, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const cookie = (/(acs=[^;]*)/.exec(res.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
  return { status: res.status, data: await res.json().catch(() => null), cookie };
}

/** Email sign-up (start → verify). Returns the verify response, or the failing start response. */
export async function emailSignup(env: Env, email: string, callsign: string, ip?: string): Promise<Res> {
  const start = await call(env, "POST", "/auth/email/start", { email, callsign }, {}, ip);
  if (start.status !== 200 || !start.data?.devToken) return start;
  return call(env, "POST", "/auth/email/verify", { token: start.data.devToken }, {}, ip);
}

// ---- a software WebAuthn authenticator ----

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const cborText = (s: string) => concat(new Uint8Array([0x60 + s.length]), enc.encode(s));
const cborBytes = (b: Uint8Array) =>
  b.length < 24
    ? concat(new Uint8Array([0x40 + b.length]), b)
    : b.length < 256
      ? concat(new Uint8Array([0x58, b.length]), b)
      : concat(new Uint8Array([0x59, b.length >> 8, b.length & 0xff]), b);

function rawToDer(raw: Uint8Array): Uint8Array {
  const trim = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return v;
  };
  const int = (v: Uint8Array) => concat(new Uint8Array([0x02, v.length]), v);
  const body = concat(int(trim(raw.slice(0, 32))), int(trim(raw.slice(32))));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export interface Authenticator {
  priv: CryptoKey;
  cose: Uint8Array;
  credId: Uint8Array;
  counter: number;
}

export async function newAuthenticator(): Promise<Authenticator> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const x = fromB64url(jwk.x!);
  const y = fromB64url(jwk.y!);
  const cose = concat(
    new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    new Uint8Array([0x22, 0x58, 0x20]),
    y,
  );
  return { priv: kp.privateKey, cose, credId: crypto.getRandomValues(new Uint8Array(16)), counter: 0 };
}

async function authData(a: Authenticator, attested: boolean): Promise<Uint8Array> {
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(RP_ID)));
  a.counter++;
  const cnt = new Uint8Array([a.counter >>> 24, (a.counter >>> 16) & 0xff, (a.counter >>> 8) & 0xff, a.counter & 0xff]);
  if (!attested) return concat(rpHash, new Uint8Array([0x01]), cnt);
  const credLen = new Uint8Array([a.credId.length >> 8, a.credId.length & 0xff]);
  return concat(rpHash, new Uint8Array([0x41]), cnt, new Uint8Array(16), credLen, a.credId, a.cose);
}

/** Full passkey registration (begin → finish). Returns the finish response, or the failing begin. */
export async function passkeyRegister(
  env: Env,
  callsign: string,
  a: Authenticator,
  headers: Record<string, string> = {},
): Promise<Res> {
  const begin = await call(env, "POST", "/auth/passkey/register/begin", { callsign }, headers);
  if (begin.status !== 200) return begin;
  return passkeyRegisterFinish(env, callsign, a, begin.data.challenge);
}

export async function passkeyRegisterFinish(env: Env, callsign: string, a: Authenticator, challenge: string) {
  const clientDataJSON = enc.encode(JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN }));
  const attestationObject = concat(
    new Uint8Array([0xa3]),
    cborText("fmt"),
    cborText("none"),
    cborText("attStmt"),
    new Uint8Array([0xa0]),
    cborText("authData"),
    cborBytes(await authData(a, true)),
  );
  return call(env, "POST", "/auth/passkey/register/finish", {
    callsign,
    credential: {
      id: b64url(a.credId),
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject) },
    },
  });
}

/** Full passkey login (begin → finish). */
export async function passkeyLogin(env: Env, callsign: string, a: Authenticator, ip?: string): Promise<Res> {
  const begin = await call(env, "POST", "/auth/passkey/login/begin", { callsign }, {}, ip);
  if (begin.status !== 200) return begin;
  const clientDataJSON = enc.encode(
    JSON.stringify({ type: "webauthn.get", challenge: begin.data.challenge, origin: ORIGIN }),
  );
  const ad = await authData(a, false);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.priv, concat(ad, clientHash)),
  );
  return call(
    env,
    "POST",
    "/auth/passkey/login/finish",
    {
      callsign,
      credential: {
        id: b64url(a.credId),
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(ad),
          signature: b64url(rawToDer(sig)),
        },
      },
    },
    {},
    ip,
  );
}

/** Mark a base call control-verified the trusted way (the ingest-secret APRS challenge). */
export async function controlVerify(env: Env, callsign: string): Promise<void> {
  const h = { "x-ingest-secret": "test-ingest-secret" };
  await call(env, "POST", "/verify/aprs/start", { callsign }, h);
  const code = await lastCode(env, callsign);
  const r = await call(env, "POST", "/verify/aprs/confirm", { callsign, code }, h);
  if (r.data?.verified !== true) throw new Error(`control-verify ${callsign} failed: ${JSON.stringify(r.data)}`);
}

/** The most recent verification code queued to a callsign over APRS (read off the outbox). */
export async function lastCode(env: Env, callsign: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT payload FROM aprs_outbox WHERE payload LIKE ? ORDER BY id DESC LIMIT 1")
    .bind(`:${callsign.padEnd(9)}:%`)
    .first<{ payload: string }>();
  return /code (\d{6})/.exec(row?.payload ?? "")?.[1];
}
