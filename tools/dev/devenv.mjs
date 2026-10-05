// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The development instance's settings: `.env.dev` at the top of the checkout (gitignored), written on the
 * first `pnpm dev` with fresh secrets and keys, and the derived settings every dev command shares (ports,
 * the data folder, the gateway's environment). The file holds only what is generated or chosen once; the
 * origin settings follow from the ports at each start, so changing a port needs no edit. A key added to
 * the file by hand (SMTP_HOST, OFFLINE_TILES_PATH, …) reaches the gateway as it is.
 */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The attested receiving site of the dev instance: the seed data and the smoke suites hear RF through it. */
export const DEV_SITE = "OE8XXX";

const hex = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");
const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** An Ed25519 federation key in the FED_PRIVATE_KEY form (tools/fedkey/genkey.mjs) and its public half. */
export async function fedKey() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { key: Buffer.from(JSON.stringify({ pkcs8, pub })).toString("base64"), pub };
}

/** The 16-hex-digit fingerprint a peer pins in FED_PEERS (tools/fedkey/fingerprint.mjs). */
export async function fingerprint(fedPrivateKey) {
  const { pub } = JSON.parse(Buffer.from(fedPrivateKey, "base64").toString("utf8"));
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(pub, "base64url"));
  return Buffer.from(digest).toString("hex").slice(0, 16);
}

/** Web-push keys: the raw P-256 public point and the private scalar, both base64url (notify.ts). */
async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), priv: jwk.d };
}

/** KEY=VALUE lines; blank lines and `#` comments are skipped, and one pair of surrounding quotes is dropped. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let v = line.slice(eq + 1).trim();
    if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

async function askCall() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "N0CALL";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question("Callsign to administer the dev instance [N0CALL]: ")).trim().toUpperCase();
    return a || "N0CALL";
  } finally {
    rl.close();
  }
}

/** The settings file's text: secrets, keys and the once-chosen preferences. */
async function freshEnvText(call) {
  const vapid = await vapidKeys();
  const fed = await fedKey();
  const peer = await fedKey();
  return `# The development instance (pnpm dev). Generated once; gitignored. Delete it to start over.
# Keys added here reach the dev gateway as they are (SMTP_HOST, OFFLINE_TILES_PATH, MIN_TRUST, …).

# --- secrets the gateway needs to start, and the ingest's shared secret ---
INGEST_SECRET=dev-ingest-${hex(16)}
OPERATOR_SECRET=dev-operator-${hex(16)}
SESSION_SECRET=dev-session-${hex(16)}

# --- the operator: sign in with this call, then run pnpm dev:verify ---
ADMIN_CALLSIGNS=${call}

# --- dev conveniences: sign-in links come back in-band (and in the gateway log), no mail server needed ---
ALLOW_DEV_TOKENS=1
# the attested receiving site, so a frame heard through it reaches Tier A (the seed data uses it)
FIRST_PARTY_SITES=${DEV_SITE}
# a dev instance does not ask GitHub for new releases
UPDATE_CHECK=0

# --- web push ---
VAPID_PUBLIC=${vapid.pub}
VAPID_PRIVATE=${vapid.priv}

# --- federation: this instance's signing key, and the second instance pnpm dev:peer starts ---
FED_PRIVATE_KEY=${fed.key}
FED_ALLOW_PRIVATE=1
FED_SYNC_INTERVAL_MS=15000
DEV_PEER_FED_PRIVATE_KEY=${peer.key}

# --- the ingest (pnpm dev --ingest, or DEV_INGEST=1): a receive-only APRS-IS slice around Graz ---
DEV_INGEST=0
APRSIS_FILTER=r/47.07/15.42/100

# --- ports ---
DEV_WEB_PORT=5173
DEV_GATEWAY_PORT=8787
DEV_PEER_PORT=8788
`;
}

/**
 * Read the settings file, writing it first when it does not exist. `file` and `call` let the dev-stack
 * check run on its own throwaway file without asking anything.
 */
export async function loadDevEnv({ file = path.join(ROOT, ".env.dev"), call } = {}) {
  let created = false;
  if (!fs.existsSync(file)) {
    const text = await freshEnvText(call ?? process.env.DEV_CALL?.toUpperCase() ?? (await askCall()));
    fs.writeFileSync(file, text, { mode: 0o600 });
    created = true;
  }
  return { file, created, vars: parseEnv(fs.readFileSync(file, "utf8")) };
}

/** Settings only the dev tooling reads; they never reach a gateway or the ingest. */
const DEV_ONLY = /^DEV_/;
/** Secrets an ingest box never holds (.claude/rules/ingest-locality.md; configuration reference). */
const NOT_FOR_INGEST = /^(?:OPERATOR_SECRET|SESSION_SECRET|FED_|VAPID_|ADMIN_CALLSIGNS$)/;

const num = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Ports and folders, from the command line first, then the settings file. */
export function layout(vars, opts = {}) {
  const data = path.resolve(opts.data ?? path.join(ROOT, ".dev"));
  return {
    web: num(opts.webPort ?? vars.DEV_WEB_PORT, 5173),
    gateway: num(opts.gatewayPort ?? vars.DEV_GATEWAY_PORT, 8787),
    peer: num(opts.peerPort ?? vars.DEV_PEER_PORT, 8788),
    data,
  };
}

const settings = (vars) => Object.fromEntries(Object.entries(vars).filter(([k]) => !DEV_ONLY.test(k)));

/**
 * The gateway's environment. `appUrl` is the origin the browser opens: the Vite dev server, or the gateway
 * itself when it serves the built app. Values in the settings file win over the derived ones.
 */
export function gatewayEnv(vars, lay, { appUrl, webDist } = {}) {
  return {
    PORT: String(lay.gateway),
    APP_URL: appUrl,
    DB_PATH: path.join(lay.data, "aprscaching.db"),
    MEDIA_DIR: path.join(lay.data, "media"),
    ...(webDist ? { WEB_DIST: webDist } : {}),
    ...settings(vars),
  };
}

/**
 * The second instance (pnpm dev:peer). It opens on 127.0.0.1, another host than the first instance's
 * localhost, so the two keep separate session cookies in one browser. A passkey needs a domain, so sign in
 * there with an email link.
 */
export function peerEnv(vars, lay, { mainFingerprint, webDist }) {
  const own = settings(vars);
  return {
    ...own,
    PORT: String(lay.peer),
    APP_URL: `http://127.0.0.1:${lay.peer}`,
    INSTANCE: "peer.localhost",
    DB_PATH: path.join(lay.data, "peer", "aprscaching.db"),
    MEDIA_DIR: path.join(lay.data, "peer", "media"),
    FED_PRIVATE_KEY: vars.DEV_PEER_FED_PRIVATE_KEY,
    FED_PEERS: `http://127.0.0.1:${lay.gateway}#${mainFingerprint}`,
    FED_CORROBORATION_QUORUM: "1",
    ...(webDist ? { WEB_DIST: webDist } : {}),
  };
}

/** The ingest's environment: the shared ingest secret and the APRS-IS settings, never the gateway's secrets. */
export function ingestEnv(vars, lay) {
  const own = Object.fromEntries(Object.entries(settings(vars)).filter(([k]) => !NOT_FOR_INGEST.test(k)));
  return { INGEST_URL: `http://127.0.0.1:${lay.gateway}/ingest`, ...own };
}
