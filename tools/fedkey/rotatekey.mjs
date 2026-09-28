// SPDX-License-Identifier: AGPL-3.0-or-later
// Rotate an instance's federation signing key. Given the CURRENT FED_PRIVATE_KEY, mint a NEW
// signing key plus the continuity artifacts so peers keep verifying across the rotation:
//   • FED_PRIVATE_KEY — the NEW signing key (set this; retire the old one)
//   • FED_KEY_HISTORY — publishes the OLD public key with an `until`: frames it signed (still in
//                       flight on store-and-forward carriers) verify until then, never after
//   • FED_ROTATIONS   — the rotation record: the new key signed by the OLD key (continuity proof)
//
//   FED_PRIVATE_KEY="$OLD" node tools/fedkey/rotatekey.mjs
//   FED_PRIVATE_KEY="$OLD" FED_ROTATION_GRACE_DAYS=2 node tools/fedkey/rotatekey.mjs   (grace, default 7)
//
// Peers treat a rotated-away key as revoked once its grace has passed, whatever a later descriptor
// says. To drop a LEAKED key at once, publish it with revoked:true, e.g.
//   FED_KEY_HISTORY='[{"x":"<leaked-pub>","revoked":true}]'  — consumers then reject its signatures.

const old = process.env.FED_PRIVATE_KEY;
if (!old) {
  console.error("set FED_PRIVATE_KEY=<current key> first (the key you are rotating away from)");
  process.exit(1);
}

// must match federation.ts:stableStringify so verifyRotationRecord accepts the signature
const stableStringify = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
};

const { pkcs8: oldPkcs8, pub: oldPub } = JSON.parse(Buffer.from(old, "base64").toString());
const oldPriv = await crypto.subtle.importKey("pkcs8", Buffer.from(oldPkcs8, "base64"), { name: "Ed25519" }, false, [
  "sign",
]);

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const newPkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
const newPub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const newPrivate = Buffer.from(JSON.stringify({ pkcs8: newPkcs8, pub: newPub })).toString("base64");

const at = Math.floor(Date.now() / 1000);
const sig = Buffer.from(
  await crypto.subtle.sign(
    "Ed25519",
    oldPriv,
    new TextEncoder().encode(stableStringify({ key: newPub, prevKey: oldPub, at })),
  ),
).toString("base64url");

const graceDays = Number(process.env.FED_ROTATION_GRACE_DAYS ?? 7);
if (!Number.isFinite(graceDays) || graceDays < 0) {
  console.error("FED_ROTATION_GRACE_DAYS must be a non-negative number of days");
  process.exit(1);
}
const history = [{ x: oldPub, until: at + Math.round(graceDays * 86400) }];
const rotations = [{ key: newPub, prevKey: oldPub, at, sig }];

if (process.argv.includes("--raw")) {
  process.stdout.write(
    JSON.stringify({
      FED_PRIVATE_KEY: newPrivate,
      FED_KEY_HISTORY: JSON.stringify(history),
      FED_ROTATIONS: JSON.stringify(rotations),
    }),
  );
} else {
  console.log("Rotation complete. Set these (keep the old key around only inside FED_KEY_HISTORY):\n");
  console.log("FED_PRIVATE_KEY=" + newPrivate + "\n");
  console.log("FED_KEY_HISTORY=" + JSON.stringify(history) + "\n");
  console.log("FED_ROTATIONS=" + JSON.stringify(rotations) + "\n");
  console.log("Append earlier rotations/history entries if you have them. Drop the old key entirely once");
  console.log('every peer has re-synced; mark a LEAKED key {"revoked":true} to reject it immediately.');
}
