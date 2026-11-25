// SPDX-License-Identifier: AGPL-3.0-or-later
// An ingest box enrolled with its own key, driven through the real gateway with the ingest box's own signing
// code (apps/ingest gatewayauth.ts): the sysop's enrollment code, the box's enrollment, the sysop's trust of
// its receiving sites, and requests the box signs. A callsign proof heard on the air counts only from such a
// box, so every test that verifies a call on the air enrolls one.
import { createPrivateKey } from "node:crypto";
import type { Env } from "@aprscaching/gateway/env";
import { call, ORIGIN, type Res } from "./authflow.js";
import { serve } from "./fedpeer.js";
import { enrollBody, newBoxKey, signedHeaders, type BoxKey } from "../../../../apps/ingest/src/gatewayauth.js";

const OPS = { "x-operator-secret": "test-operator-secret" };

/** A fresh Ed25519 key for box `box`, as `pnpm ingest enroll` makes one. */
export function boxKey(box: string): BoxKey {
  const { boxKey: pkcs8, publicKey } = newBoxKey();
  return {
    box,
    key: createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" }),
    publicKey,
  };
}

/** Box `box` enrolled with a code the operator secret creates; throws when either step is refused. */
export async function enrollBox(env: Env, box: string, codeBody: Record<string, unknown> = {}): Promise<BoxKey> {
  const k = boxKey(box);
  const code = await call(env, "POST", "/api/admin/boxes/codes", codeBody, OPS);
  if (code.status !== 201) throw new Error(`enrollment code refused: ${JSON.stringify(code.data)}`);
  const e = await call(env, "POST", "/ingest/enroll", enrollBody(k, code.data.code));
  if (e.status !== 201) throw new Error(`enrollment of ${box} refused: ${JSON.stringify(e.data)}`);
  return k;
}

/** Box `box` enrolled, and its hearings at `sites` trusted by the sysop. */
export async function trustedBox(env: Env, box: string, sites: string[]): Promise<BoxKey> {
  const k = await enrollBox(env, box);
  const t = await call(env, "POST", `/api/admin/boxes/${box}/trust`, { trusted: true, sites }, OPS);
  if (t.status !== 200) throw new Error(`trusting ${box} refused: ${JSON.stringify(t.data)}`);
  return k;
}

/** One JSON request signed by box `k`, with any `headers` beside the signature. */
export async function signedCall(
  env: Env,
  k: BoxKey,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const url = `${ORIGIN}${path}`;
  const text = body === undefined ? undefined : JSON.stringify(body);
  const res = await serve(env)(
    new Request(url, {
      method,
      headers: { "content-type": "application/json", ...headers, ...signedHeaders(k, method, url, text) },
      body: text,
    }),
  );
  const cookie = (/(acs=[^;]*)/.exec(res.headers.get("set-cookie") ?? "") ?? [])[1] ?? "";
  return { status: res.status, data: await res.json().catch(() => null), cookie };
}

/** Control-verify `callsign` the real way: its holder's session starts a challenge, and `box` delivers the
 *  holder's `VERIFY <code>`, heard on its TNC at the site OE8XXX it is trusted for. */
export async function rfVerify(env: Env, box: BoxKey, cookie: string, callsign: string): Promise<void> {
  const s = await call(env, "POST", "/verify/aprs/start", { callsign }, { cookie });
  if (s.status !== 200) throw new Error(`verify start ${callsign} failed: ${JSON.stringify(s.data)}`);
  await signedCall(env, box, "POST", "/ingest", {
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
  });
  const st = await call(env, "GET", `/verify/aprs/status?callsign=${callsign}`);
  if (st.data?.verified !== true) throw new Error(`rf-verify ${callsign} failed`);
}

const siteBoxes = new WeakMap<Env, BoxKey>();

/** The box `env`'s sysop trusts for the site OE8XXX, enrolled on first use: where an on-air VERIFY is heard. */
export async function siteBox(env: Env): Promise<BoxKey> {
  let k = siteBoxes.get(env);
  if (!k) siteBoxes.set(env, (k = await trustedBox(env, "site-rx", ["OE8XXX"])));
  return k;
}
