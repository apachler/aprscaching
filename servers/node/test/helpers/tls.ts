// SPDX-License-Identifier: AGPL-3.0-or-later
// A throwaway P-256 CA and a leaf it signs, made with the openssl CLI the way a station's own CA is:
// the CA is name-constrained to private addresses, the leaf names the addresses the test connects to.
// `hasOpenssl` is false where the CLI is missing, so a suite can skip its TLS part cleanly.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

export interface TestPki {
  dir: string;
  caCert: string;
  cert: string;
  key: string;
}

const run = (dir: string, args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });

/** A CA and a leaf for `ips`, in a fresh temp directory. `name` makes a second leaf beside the first. */
export function makePki(
  ips: string[],
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-tls-")),
  name = "leaf",
): TestPki {
  if (!fs.existsSync(path.join(dir, "ca.crt"))) {
    fs.writeFileSync(
      path.join(dir, "ca.cnf"),
      [
        "[req]",
        "distinguished_name=dn",
        "prompt=no",
        "[dn]",
        "CN=aprscaching test CA",
        "[v3_ca]",
        "basicConstraints=critical,CA:TRUE,pathlen:0",
        "keyUsage=critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier=hash",
        "nameConstraints=critical,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0," +
          "permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:192.0.2.0/255.255.255.0,permitted;IP:127.0.0.0/255.0.0.0",
        "",
      ].join("\n"),
    );
    run(dir, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
    run(dir, "req -x509 -new -key ca.key -days 2 -config ca.cnf -extensions v3_ca -out ca.crt".split(" "));
  }
  fs.writeFileSync(
    path.join(dir, `${name}.ext`),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${ips.map((ip) => `IP:${ip}`).join(",")}`,
      "authorityKeyIdentifier=keyid",
      "",
    ].join("\n"),
  );
  run(dir, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`]);
  run(dir, ["req", "-new", "-key", `${name}.key`, "-subj", "/CN=aprscaching station", "-out", `${name}.csr`]);
  run(
    dir,
    `x509 -req -in ${name}.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile ${name}.ext -out ${name}.crt`.split(
      " ",
    ),
  );
  return {
    dir,
    caCert: path.join(dir, "ca.crt"),
    cert: path.join(dir, `${name}.crt`),
    key: path.join(dir, `${name}.key`),
  };
}
