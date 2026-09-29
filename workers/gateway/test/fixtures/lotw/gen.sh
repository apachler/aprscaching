#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Generates the SYNTHETIC certificates the LoTW verification tests use. None of this is ARRL material:
# a throwaway "Synthetic Test LoTW Root", an intermediate under it, and callsign certificates shaped like
# LoTW's — the callsign in the subject attribute AROcallsign (OID 1.3.6.1.4.1.12348.1.1, as tqsllib
# defines it) — plus a rogue root that no test trusts. Rerun to regenerate: ./gen.sh
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat >"$work/ca.cnf" <<CNF
oid_section = oids
[oids]
AROcallsign = 1.3.6.1.4.1.12348.1.1
[ca]
default_ca = test
[test]
dir = $work
database = $work/index.txt
new_certs_dir = $work
serial = $work/serial
default_md = sha256
policy = any
unique_subject = no
copy_extensions = none
[any]
AROcallsign = optional
commonName = optional
organizationName = optional
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[v3_user]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature
[req]
distinguished_name = dn
[dn]
CNF
touch "$work/index.txt"
echo 1000 >"$work/serial"

key() { openssl genrsa -out "$1" 2048 2>/dev/null; }
# sign <subject> <csr-key> <issuer-cert|self> <issuer-key> <ext> <start> <end> <out> [md]
sign() {
  local subj=$1 k=$2 icert=$3 ikey=$4 ext=$5 start=$6 end=$7 out=$8 md=${9:-sha256}
  openssl req -new -config "$work/ca.cnf" -key "$k" -subj "$subj" -out "$work/req.csr" 2>/dev/null
  if [[ $icert == self ]]; then
    openssl ca -batch -config "$work/ca.cnf" -selfsign -keyfile "$k" -in "$work/req.csr" -extensions "$ext" \
      -startdate "$start" -enddate "$end" -md "$md" -notext -out "$out" 2>/dev/null
  else
    openssl ca -batch -config "$work/ca.cnf" -cert "$icert" -keyfile "$ikey" -in "$work/req.csr" -extensions "$ext" \
      -startdate "$start" -enddate "$end" -md "$md" -notext -out "$out" 2>/dev/null
  fi
}

key root.key; key ca.key; key user.key; key rogue.key
sign "/O=Synthetic Test/CN=Synthetic Test LoTW Root" root.key self root.key v3_ca 20200101000000Z 21000101000000Z root.pem sha512
sign "/O=Synthetic Test/CN=Synthetic Test LoTW Production CA" ca.key root.pem root.key v3_ca 20200101000000Z 21000101000000Z ca.pem
sign "/AROcallsign=OE8APR/CN=Synthetic Test Operator" user.key ca.pem ca.key v3_user 20200101000000Z 20991231235959Z user-oe8apr.pem
sign "/AROcallsign=DL1AAA/CN=Synthetic Other Operator" user.key ca.pem ca.key v3_user 20200101000000Z 20991231235959Z user-dl1aaa.pem
sign "/AROcallsign=OE8APR/CN=Synthetic Test Operator" user.key ca.pem ca.key v3_user 20200101000000Z 20210101000000Z user-expired.pem
sign "/O=Synthetic Test/CN=Synthetic Rogue Root" rogue.key self rogue.key v3_ca 20200101000000Z 21000101000000Z rogue-root.pem
sign "/AROcallsign=OE8APR/CN=Synthetic Test Operator" user.key rogue-root.pem rogue.key v3_user 20200101000000Z 20991231235959Z user-rogue.pem
# The user's key as binary PKCS#8 (the tests sign challenges with it), and a PKCS#12 bundle of the key with
# its chain as TQSL saves one (password "synthetic"), for trying the web app's LoTW card by hand.
openssl pkcs8 -topk8 -nocrypt -in user.key -outform DER -out user.key.der
openssl pkcs12 -export -inkey user.key -in user-oe8apr.pem -certfile <(cat ca.pem root.pem) \
  -name "TrustedQSL user certificate" -passout pass:synthetic -out user-oe8apr.p12
rm -f root.key ca.key rogue.key user.key
