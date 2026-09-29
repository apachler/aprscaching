// SPDX-License-Identifier: AGPL-3.0-or-later
// The minimal X.509 reader behind LoTW verification, and the LoTW chain rules, against SYNTHETIC
// certificates (test/fixtures/lotw/gen.sh) shaped like LoTW's: the callsign is the subject attribute
// AROcallsign (1.3.6.1.4.1.12348.1.1). None of the fixtures is ARRL material.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCertificate, pemBlocks, verifiedBy } from "../src/x509.js";
import { AROCALLSIGN_OID, lotwCallsign, verifyLotwChain } from "../src/verify_lotw.js";

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`./fixtures/lotw/${f}`, import.meta.url)), "utf8");
const der = (f: string) => pemBlocks(fx(f))[0]!;
const NOW = Date.UTC(2026, 8, 29);

describe("parseCertificate", () => {
  it("reads subject attributes, validity, CA flag and key usage", () => {
    const leaf = parseCertificate(der("user-oe8apr.pem"));
    expect(leaf.subjectAttrs).toContainEqual({ oid: AROCALLSIGN_OID, value: "OE8APR" });
    expect(leaf.subjectAttrs).toContainEqual({ oid: "2.5.4.3", value: "Synthetic Test Operator" });
    expect(leaf.notBefore).toBe(Date.UTC(2020, 0, 1));
    expect(leaf.notAfter).toBe(Date.UTC(2099, 11, 31, 23, 59, 59));
    expect(leaf.ca).toBe(false);
    expect(leaf.digitalSignature).toBe(true);
    expect(leaf.sigAlg).toBe("1.2.840.113549.1.1.11");
    const root = parseCertificate(der("root.pem"));
    expect(root.ca).toBe(true);
    expect(root.sigAlg).toBe("1.2.840.113549.1.1.13");
    // GeneralizedTime past 2049
    expect(root.notAfter).toBe(Date.UTC(2100, 0, 1));
  });

  it("rejects truncated or trailing-garbage DER", () => {
    const d = der("user-oe8apr.pem");
    expect(() => parseCertificate(d.slice(0, d.length - 10))).toThrow();
    expect(() => parseCertificate(new Uint8Array([...d, 0]))).toThrow();
    expect(() => parseCertificate(new Uint8Array([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]))).toThrow();
  });

  it("verifies an issuer's signature and refuses a stranger's", async () => {
    const leaf = parseCertificate(der("user-oe8apr.pem"));
    const ca = parseCertificate(der("ca.pem"));
    const root = parseCertificate(der("root.pem"));
    expect(await verifiedBy(leaf, ca)).toBe(true);
    expect(await verifiedBy(ca, root)).toBe(true);
    expect(await verifiedBy(leaf, root)).toBe(false);
  });
});

describe("verifyLotwChain", () => {
  const anchors = [parseCertificate(der("root.pem"))];
  const chain = (leaf: string) => [der(leaf), der("ca.pem"), der("root.pem")];

  it("accepts a current callsign certificate that chains to a trusted root", async () => {
    const r = await verifyLotwChain(chain("user-oe8apr.pem"), anchors, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(lotwCallsign(r.leaf)).toBe("OE8APR");
  });

  it("refuses an expired certificate, one under an untrusted root, and a chain missing its CA", async () => {
    expect((await verifyLotwChain(chain("user-expired.pem"), anchors, NOW)).ok).toBe(false);
    expect((await verifyLotwChain([der("user-rogue.pem"), der("rogue-root.pem")], anchors, NOW)).ok).toBe(false);
    expect((await verifyLotwChain([der("user-oe8apr.pem")], anchors, NOW)).ok).toBe(false);
    // no trust anchor configured: nothing verifies
    expect((await verifyLotwChain(chain("user-oe8apr.pem"), [], NOW)).ok).toBe(false);
  });

  it("will not take a CA certificate as the callsign certificate", async () => {
    expect((await verifyLotwChain([der("ca.pem"), der("root.pem")], anchors, NOW)).ok).toBe(false);
  });
});
