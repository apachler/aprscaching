#!/usr/bin/env bash
set -euo pipefail
# Package deploy/oci as an OCI Resource Manager stack zip.
# Usage: bash scripts/build-oci-stack.sh [ref]
#
# Resource Manager reads main.tf and schema.yaml from the ZIP ROOT, so the files are staged flat
# rather than under deploy/oci/. The ref (a tag on a release build) is stamped over the repo_ref
# default, so a stack downloaded from a release deploys exactly that release.
cd "$(dirname "$0")/.."                                     # repo root
REF="${1:-$(git describe --tags --always 2>/dev/null || echo main)}"
OUT="dist/oci"
ZIP="aprscaching-oci-stack.zip"

# Kept in step with tools/checks/oci-stack.mjs, which fails the build if this list and the contents
# of deploy/oci/ ever drift apart.
FILES=(main.tf cloud-init.yaml schema.yaml README-stack.md)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
for f in "${FILES[@]}"; do cp "deploy/oci/$f" "$STAGE/$f"; done

# The build script rewrites this default; main.tf documents the line shape it depends on.
sed -i.bak "s|^  default     = \"main\"$|  default     = \"$REF\"|" "$STAGE/main.tf"
rm -f "$STAGE/main.tf.bak"
grep -q "  default     = \"$REF\"" "$STAGE/main.tf" || {
  echo "build-oci-stack: repo_ref default not stamped — main.tf line shape changed" >&2
  exit 1
}

mkdir -p "$OUT"
rm -f "$OUT/$ZIP"
ABS_OUT="$(cd "$OUT" && pwd)/$ZIP"
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -q -X "$ABS_OUT" "${FILES[@]}")
else
  # Every GitHub runner ships zip; python3 keeps the script runnable on a dev box that does not.
  (cd "$STAGE" && python3 -m zipfile -c "$ABS_OUT" "${FILES[@]}")
fi

echo ">> $OUT/$ZIP  (repo_ref=$REF)"
