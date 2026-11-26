#!/usr/bin/env sh
# Enroll an interop stack's ingest as the packet BBS box of its gateway and print the two settings it runs with:
#
#   enroll-bbs-box.sh <gateway base URL> <box id>   →   BOX_ID=…  BOX_KEY=…   (stdout, one per line)
#
# The packet BBS and FBB forwarding take only a box enrolled with its own key that the sysop lets run the
# instance's services; the shared INGEST_SECRET runs no BBS. This takes a one-time code with OPERATOR_SECRET,
# enrolls with apps/ingest's own enroll.ts, and switches the box's services on. Run from the repository root.
# BOX_KEY is a private key: stdout belongs in the ingest's environment, not on a screen.
set -eu
base="${1:?gateway base URL}"
box="${2:?box id}"
: "${OPERATOR_SECRET:?OPERATOR_SECRET is needed to create the enrollment code}"
# node is the one HTTP client every interop image has: the slim images ship neither curl nor wget
code="$(BASE="$base" node -e '
  fetch(process.env.BASE + "/api/admin/boxes/codes", {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-secret": process.env.OPERATOR_SECRET },
    body: "{}",
  }).then(async (r) => {
    const t = await r.text();
    if (r.status !== 201) { console.error(`enrollment code: ${r.status} ${t}`); process.exit(1); }
    console.log(JSON.parse(t).code);
  }, (e) => { console.error(`enrollment code: ${e}`); process.exit(1); });
')"
settings="$(cd apps/ingest && node --import tsx src/enroll.ts --url "$base/ingest" --code "$code" --box "$box")"
BASE="$base" BOX="$box" node -e '
  fetch(`${process.env.BASE}/api/admin/boxes/${process.env.BOX}/services`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-secret": process.env.OPERATOR_SECRET },
    body: JSON.stringify({ services: true }),
  }).then(async (r) => {
    if (r.status !== 200) { console.error(`services: ${r.status} ${await r.text()}`); process.exit(1); }
  }, (e) => { console.error(`services: ${e}`); process.exit(1); });
'
printf '%s\n' "$settings"
