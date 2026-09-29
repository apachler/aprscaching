// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * LoTW callsign certificate, opened in the browser. TQSL exports a callsign certificate as a
 * password-protected PKCS#12 (.p12) file holding the RSA private key and the certificate chain. WebCrypto
 * cannot read PKCS#12, so node-forge (BSD-3-Clause) decrypts it here — loaded only when someone verifies
 * this way. The private key is imported into WebCrypto as non-extractable, signs the gateway's challenge
 * message, and is dropped; only the certificates and the signature leave the browser.
 */

export interface LotwProof {
  /** The certificates in the file (the callsign certificate and its CA chain), base64 DER. */
  certificates: string[];
  /** RSASSA-PKCS1-v1_5 / SHA-256 signature over the challenge message, base64. */
  signature: string;
}

/** PKCS#12 bag types (RFC 7292 §4.2). */
const BAG = {
  key: "1.2.840.113549.1.12.10.1.1",
  shroudedKey: "1.2.840.113549.1.12.10.1.2",
  cert: "1.2.840.113549.1.12.10.1.3",
};

const toBytes = (binary: string) => Uint8Array.from(binary, (c) => c.charCodeAt(0));
const toBase64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/** Open `file` with `password` and sign `message` with its private key. Throws a readable Error. */
export async function signWithP12(file: ArrayBuffer, password: string, message: string): Promise<LotwProof> {
  const forge = (await import("node-forge")).default;
  let p12: ReturnType<typeof forge.pkcs12.pkcs12FromAsn1>;
  try {
    let binary = "";
    const bytes = new Uint8Array(file);
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(binary)), false, password);
  } catch (e) {
    const m = (e as Error).message;
    throw new Error(/MAC|password/i.test(m) ? "Wrong password for this file." : "This is not a readable .p12 file.", {
      cause: e,
    });
  }
  const bags = (type: string) => p12.getBags({ bagType: type })[type] ?? [];
  const certs = bags(BAG.cert);
  const keys = [...bags(BAG.shroudedKey), ...bags(BAG.key)];
  const key = keys.find((k) => k.key)?.key as import("node-forge").pki.rsa.PrivateKey | undefined;
  if (!key) throw new Error("The file holds no RSA private key — export the callsign certificate from TQSL.");
  const certificates = certs.flatMap((b) =>
    b.cert ? [forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(b.cert)).getBytes())] : [],
  );
  if (certificates.length === 0) throw new Error("The file holds no certificate.");

  const pkcs8 = toBytes(forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))).getBytes());
  const signer = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  pkcs8.fill(0);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(message));
  return { certificates, signature: toBase64(sig) };
}
