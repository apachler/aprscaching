// SPDX-License-Identifier: AGPL-3.0-or-later
// The WebAuthn CBOR decoder reads input an anonymous request supplies: the register-finish attestationObject and
// the login assertion's authenticator data. A declared length or item count is bounded by the bytes that follow
// it, so a 5-byte header declaring 2^32-1 entries is refused at once instead of looping or allocating per entry,
// and the gateway keeps answering while such a request is refused.
import { describe, it, expect } from "vitest";
import { WEBAUTHN_MAX_BYTES, verifyAssertion, verifyRegistration } from "../src/webauthn.js";
import { route } from "../src/app.js";
import { bytesToB64url } from "../src/util/b64.js";
import type { Env } from "../src/env.js";
import type { ExecCtx } from "../src/runtime.js";

const enc = new TextEncoder();
const RP_ID = "aprscaching.net";
const ORIGIN = "https://aprscaching.net";
const CHALLENGE = bytesToB64url(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]));
const regClientData = enc.encode(JSON.stringify({ type: "webauthn.create", challenge: CHALLENGE, origin: ORIGIN }));
const getClientData = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: CHALLENGE, origin: ORIGIN }));

const bytes = (...b: number[]) => new Uint8Array(b);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const MAP_MAX = bytes(0xba, 0xff, 0xff, 0xff, 0xff); // map, 4-byte count 0xFFFFFFFF, no entries
const ARRAY_MAX = bytes(0x9a, 0xff, 0xff, 0xff, 0xff); // array, 4-byte count 0xFFFFFFFF, no items

const register = (attestationObject: Uint8Array) =>
  verifyRegistration({
    clientDataJSON: regClientData,
    attestationObject,
    challenge: CHALLENGE,
    origins: [ORIGIN],
    rpId: RP_ID,
  });

/** Authenticator data with the AT flag: rpIdHash, flags UP|AT, counter 0, a zero aaguid, an empty credential id,
 *  then `cose` where the credential public key goes. */
async function attestedAuthData(cose: Uint8Array): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(RP_ID)));
  return concat(rpIdHash, bytes(0x41, 0, 0, 0, 0), new Uint8Array(16), bytes(0x00, 0x00), cose);
}

/** The attestationObject {"authData": authData} — the one field verifyRegistration reads. */
function attObject(authData: Uint8Array): Uint8Array {
  const key = concat(bytes(0x68), enc.encode("authData"));
  const len = authData.length;
  const head = len < 256 ? bytes(0x58, len) : bytes(0x59, len >> 8, len & 0xff);
  return concat(bytes(0xa1), key, head, authData);
}

const assertWith = async (authenticatorData: Uint8Array) =>
  verifyAssertion({
    clientDataJSON: getClientData,
    authenticatorData,
    signature: bytes(0x30, 0x00),
    coseKey: "",
    challenge: CHALLENGE,
    origins: [ORIGIN],
    rpId: RP_ID,
    storedCounter: 0,
  });

describe("WebAuthn CBOR — a declared count above the input is refused at once", () => {
  for (const [name, header] of [
    ["map header BA FF FF FF FF", MAP_MAX],
    ["array header 9A FF FF FF FF", ARRAY_MAX],
  ] as const) {
    it(`${name} as the attestationObject (register)`, async () => {
      await expect(register(header)).rejects.toThrow(/cbor: truncated/);
    });

    it(`${name} as the credential key in the login assertion's authenticator data`, async () => {
      const ad = await attestedAuthData(header);
      await expect(assertWith(ad)).rejects.toThrow(/cbor: truncated/);
    });

    it(`${name} as the credential key in the registration's authenticator data`, async () => {
      const att = attObject(await attestedAuthData(header));
      await expect(register(att)).rejects.toThrow(/cbor: truncated/);
    });
  }
});

describe("WebAuthn CBOR — malformed input is refused", () => {
  it("a byte string declaring more bytes than follow", async () => {
    // {"authData": h'…'} with the byte string declaring 0xFFFF bytes and carrying 2
    const att = concat(bytes(0xa1, 0x68), enc.encode("authData"), bytes(0x59, 0xff, 0xff, 0x01, 0x02));
    await expect(register(att)).rejects.toThrow(/cbor: truncated/);
  });

  it("a text string declaring more bytes than follow", async () => {
    await expect(register(bytes(0xa1, 0x7a, 0xff, 0xff, 0xff, 0xff, 0x61))).rejects.toThrow(/cbor: truncated/);
  });

  it("an array declaring more items than bytes follow", async () => {
    await expect(register(bytes(0x83, 0x01, 0x02))).rejects.toThrow(/cbor: truncated/);
  });

  it("a map declaring more entries than bytes follow", async () => {
    await expect(register(bytes(0xa2, 0x01, 0x02, 0x03))).rejects.toThrow(/cbor: truncated/);
  });

  it("an indefinite length, which WebAuthn's canonical CBOR never uses", async () => {
    await expect(register(bytes(0xbf, 0xff))).rejects.toThrow(/cbor: indefinite length unsupported/);
    await expect(register(bytes(0x5f, 0x41, 0x00, 0xff))).rejects.toThrow(/cbor: indefinite length unsupported/);
  });

  it("a read past the end: a length header cut short, and an empty input", async () => {
    await expect(register(bytes(0x9a, 0xff, 0xff))).rejects.toThrow(/cbor: truncated/);
    await expect(register(bytes(0x59, 0x01))).rejects.toThrow(/cbor: truncated/);
    await expect(register(new Uint8Array(0))).rejects.toThrow(/cbor: truncated/);
    // a COSE key position past the end of the authenticator data
    await expect(assertWith(await attestedAuthData(new Uint8Array(0)))).rejects.toThrow(/cbor: truncated/);
  });

  it("nesting deeper than the cap", async () => {
    const deep = new Uint8Array(64).fill(0x81); // [[[[ … 64 deep
    await expect(register(concat(deep, bytes(0x00)))).rejects.toThrow(/cbor: nested too deep/);
  });

  it("authenticator data shorter than its fixed header or its declared credential id", async () => {
    await expect(assertWith(new Uint8Array(20))).rejects.toThrow(/authenticator data truncated/);
    const ad = await attestedAuthData(new Uint8Array(0));
    ad[53] = 0xff; // credential id length 0xFF00, nothing after it
    await expect(assertWith(ad)).rejects.toThrow(/authenticator data truncated/);
  });

  it("an attestationObject that is not a map", async () => {
    await expect(register(bytes(0x01))).rejects.toThrow(/not a map/);
  });
});

describe("WebAuthn input — larger than a real one is refused before decoding", () => {
  // As large as the gateway's request body allows: an array header declaring 15 M items, then 15 M empty byte
  // strings — every count holds against the bytes left, so only the input cap stands between it and 15 M decodes.
  const N = 15_000_000;
  const bodyCap = () => {
    const a = new Uint8Array(5 + N).fill(0x40);
    a.set(bytes(0x9a, (N >>> 24) & 0xff, (N >>> 16) & 0xff, (N >>> 8) & 0xff, N & 0xff));
    return a;
  };

  it("an attestationObject of 15 M one-byte items (register)", async () => {
    await expect(register(bodyCap())).rejects.toThrow(/attestationObject too large/);
  });

  it("authenticator data of 15 M bytes (login)", async () => {
    const ad = await attestedAuthData(bodyCap());
    await expect(assertWith(ad)).rejects.toThrow(/authenticatorData too large/);
  });

  it("a clientDataJSON above the cap", async () => {
    const cd = new Uint8Array(WEBAUTHN_MAX_BYTES + 1).fill(0x20);
    await expect(
      verifyRegistration({
        clientDataJSON: cd,
        attestationObject: bytes(0xa0),
        challenge: CHALLENGE,
        origins: [ORIGIN],
        rpId: RP_ID,
      }),
    ).rejects.toThrow(/clientDataJSON too large/);
  });

  it("an input exactly at the cap reaches the decoder", async () => {
    const att = new Uint8Array(WEBAUTHN_MAX_BYTES).fill(0x40);
    att.set(bytes(0x9a, 0x00, 0x00, 0xff, 0xff)); // 65535 declared, 65531 follow
    await expect(register(att)).rejects.toThrow(/cbor: truncated/);
  });
});

describe("WebAuthn CBOR — well-formed input still decodes", () => {
  it("a registration with an ES256 credential key yields the credential", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const cose = concat(
      bytes(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01),
      bytes(0x21, 0x58, 0x20),
      raw.slice(1, 33),
      bytes(0x22, 0x58, 0x20),
      raw.slice(33),
    );
    const att = concat(
      bytes(0xa3),
      bytes(0x63),
      enc.encode("fmt"),
      bytes(0x64),
      enc.encode("none"),
      bytes(0x67),
      enc.encode("attStmt"),
      bytes(0xa0),
      attObject(await attestedAuthData(cose)).slice(1),
    );
    const r = await register(att);
    expect(r.coseKey).toBe(bytesToB64url(cose));
    expect(r.signCount).toBe(0);
  });
});

describe("POST /auth/passkey/register/finish with a crafted attestationObject", () => {
  it("answers 4xx at once, and /health answers beside it", async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          // the stash register/begin leaves for a new account's ceremony: the challenge and its provisional account
          first: async () =>
            sql.includes("auth_challenges") ? { value: JSON.stringify({ c: CHALLENGE, a: "acct-new" }) } : null,
          run: async () => ({}),
          all: async () => ({ results: [] }),
        }),
        first: async () => ({ ok: 1 }),
      }),
      batch: async () => [],
    };
    const env = { DB: db, APP_URL: ORIGIN, SESSION_SECRET: "a-strong-session-secret" } as unknown as Env;
    const ctx = { waitUntil: () => {} } as unknown as ExecCtx;
    const finish = (att: Uint8Array) =>
      route(
        new Request(`${ORIGIN}/auth/passkey/register/finish`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({
            callsign: "N0CBOR",
            credential: {
              id: "x",
              response: { clientDataJSON: bytesToB64url(regClientData), attestationObject: bytesToB64url(att) },
            },
          }),
        }),
        env,
        ctx,
      );
    const [m, a, health] = await Promise.all([
      finish(MAP_MAX),
      finish(ARRAY_MAX),
      route(new Request(`${ORIGIN}/health`), env, ctx),
    ]);
    expect(m.status).toBe(400);
    expect(a.status).toBe(400);
    expect(await m.json()).toMatchObject({ error: expect.stringMatching(/cbor: truncated/) });
    expect(await a.json()).toMatchObject({ error: expect.stringMatching(/cbor: truncated/) });
    expect(health.status).toBe(200);
  });
});
