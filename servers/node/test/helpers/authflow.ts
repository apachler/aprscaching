// SPDX-License-Identifier: AGPL-3.0-or-later
// Drive the real auth endpoints of `handle()` over a migrated SQLite: email magic-link sign-up with
// in-band dev tokens, and passkey register/login with a software P-256 authenticator ("none"
// attestation), so tests exercise the same ceremony a browser runs.
import type { Env } from "@aprscaching/gateway/env";
import { instanceEnv, serve } from "./fedpeer.js";

export const ORIGIN = "https://gw.test";
const RP_ID = "gw.test";
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

/**
 * Email sign-up (start → verify). Returns the verify response, or the failing start response. An
 * ADMIN_CALLSIGNS call registers only through the operator's link, so for one the operator signs in with
 * the link the way the first-hour flow does, and the address is then set on the account directly.
 */
export async function emailSignup(env: Env, email: string, callsign: string, ip?: string): Promise<Res> {
  const start = await call(env, "POST", "/auth/email/start", { email, callsign }, {}, ip);
  if (start.status === 409 && start.data?.reason === "operator_call") return operatorSignup(env, callsign, email);
  if (start.status !== 200 || !start.data?.devToken) return start;
  return call(env, "POST", "/auth/email/verify", { token: start.data.devToken }, {}, ip);
}

/** The operator's sign-in link for `callsign`, opened: the account (created when new) and its session. */
export async function operatorSignup(env: Env, callsign: string, email?: string): Promise<Res> {
  const link = await call(
    env,
    "POST",
    "/auth/operator-link",
    { callsign },
    { "x-operator-secret": "test-operator-secret" },
  );
  if (link.status !== 200) return link;
  const token = new URL(link.data.link).searchParams.get("token");
  const res = await call(env, "POST", "/auth/email/verify", { token });
  if (email && res.status === 200)
    await env.DB.prepare(
      "UPDATE accounts SET email = ? WHERE account_id = (SELECT account_id FROM account_callsigns WHERE callsign = ?)",
    )
      .bind(email.toLowerCase(), callsign.toUpperCase().split("-")[0])
      .run();
  return res;
}

/** Mark a base call control-verified in the store, as any verification method would; hiding a cache needs it. */
export async function markCallVerified(env: Env, callsign: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO callsign_verifications (callsign, method, status, attempts, created_at, verified_at)
     VALUES (?, 'operator', 'verified', 0, 0, 0)
     ON CONFLICT(callsign) DO UPDATE SET status='verified'`,
  )
    .bind(callsign.toUpperCase().replace(/-\d+$/, ""))
    .run();
}

/** Email sign-up of a hider: the account, with its call control-verified. */
export async function hiderSignup(env: Env, email: string, callsign: string, ip?: string): Promise<Res> {
  const r = await emailSignup(env, email, callsign, ip);
  if (r.status === 200) await markCallVerified(env, callsign);
  return r;
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

async function authData(a: Authenticator, attested: boolean, rp = RP_ID): Promise<Uint8Array> {
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rp)));
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
  origin = ORIGIN,
): Promise<Res> {
  const begin = await call(env, "POST", "/auth/passkey/register/begin", { callsign }, headers);
  if (begin.status !== 200) return begin;
  // the authenticator signs for the relying party the instance names, as a browser does
  return passkeyRegisterFinish(env, callsign, a, begin.data.challenge, headers, origin, begin.data.rp.id);
}

/** The finish step; a browser sends its session cookie here too (HEADERS), and names the page's ORIGIN. */
export async function passkeyRegisterFinish(
  env: Env,
  callsign: string,
  a: Authenticator,
  challenge: string,
  headers: Record<string, string> = {},
  origin = ORIGIN,
  rp = RP_ID,
) {
  const clientDataJSON = enc.encode(JSON.stringify({ type: "webauthn.create", challenge, origin }));
  const attestationObject = concat(
    new Uint8Array([0xa3]),
    cborText("fmt"),
    cborText("none"),
    cborText("attStmt"),
    new Uint8Array([0xa0]),
    cborText("authData"),
    cborBytes(await authData(a, true, rp)),
  );
  return call(
    env,
    "POST",
    "/auth/passkey/register/finish",
    {
      callsign,
      credential: {
        id: b64url(a.credId),
        response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject) },
      },
    },
    headers,
  );
}

/** Full passkey login (begin → finish). */
export async function passkeyLogin(env: Env, callsign: string, a: Authenticator, ip?: string): Promise<Res> {
  const begin = await call(env, "POST", "/auth/passkey/login/begin", { callsign }, {}, ip);
  if (begin.status !== 200) return begin;
  return passkeyLoginFinish(env, callsign, a, begin.data.challenge, ip);
}

/** The login finish step, answering `challenge` (from a login begin). */
export async function passkeyLoginFinish(
  env: Env,
  callsign: string,
  a: Authenticator,
  challenge: string,
  ip?: string,
): Promise<Res> {
  const clientDataJSON = enc.encode(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN }));
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

/**
 * A sysop verifies `callsign` by hand the way Instance admin does: look the call up, then verify it for the
 * account the lookup showed (`holder`).
 */
export async function sysopVerifyCall(env: Env, cookie: string, callsign: string, note = "licence checked") {
  const seen = await call(env, "GET", `/api/admin/callsigns/${callsign}`, undefined, { cookie });
  return call(
    env,
    "POST",
    "/api/admin/verifications",
    { callsign, note, holder: seen.data?.holder?.accountId ?? null },
    { cookie },
  );
}

/** Confirm an ADMIN_CALLSIGNS call with the operator secret, the way the operator CLI does. */
export async function operatorVerify(env: Env, callsign: string): Promise<void> {
  const r = await call(env, "POST", "/verify/operator", { callsign }, { "x-operator-secret": "test-operator-secret" });
  if (r.data?.verified !== true) throw new Error(`operator-verify ${callsign} failed: ${JSON.stringify(r.data)}`);
}

/**
 * Verify a held call over RF: start a challenge for the signed-in account, then ingest the `VERIFY <code>`
 * message as heard on the TNC of the attested site OE8XXX (the env must name it in FIRST_PARTY_SITES).
 */
export async function rfVerify(env: Env, cookie: string, callsign: string): Promise<void> {
  const s = await call(env, "POST", "/verify/aprs/start", { callsign }, { cookie });
  if (s.status !== 200) throw new Error(`verify start ${callsign} failed: ${JSON.stringify(s.data)}`);
  await call(
    env,
    "POST",
    "/ingest",
    {
      packets: [
        {
          src: `${callsign}-7`,
          dst: "APRS",
          path: ["WIDE1-1", "qAR", "OE8XXX"],
          payload: `:${String(s.data.to).padEnd(9)}:${s.data.text}`,
          kind: "message",
          heardVia: "rf",
          igateCall: "OE8XXX",
          port: "kiss-tnc",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    },
    { "x-ingest-secret": "test-ingest-secret" },
  );
  const st = await call(env, "GET", `/verify/aprs/status?callsign=${callsign}`);
  if (st.data?.verified !== true) throw new Error(`rf-verify ${callsign} failed`);
}
