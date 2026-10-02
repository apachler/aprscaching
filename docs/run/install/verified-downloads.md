# Check a download

Every release file comes with a checksum and a signature. This page shows how to check both before you run it.

Every release carries, beside the OCI stack and the desktop binaries:

- `aprscaching-<version>.bundle` — the release as a git bundle. Clone it, and the checkout updates like any
  other.
- `aprscaching-<version>-source.tar.gz` — the source.
- `pocket.sh` — the Pocket installer. It carries the release's tag and the bundle's SHA-256, so once it is
  checked, it installs only that bundle and stops when the bundle does not match.
- `SHA256SUMS` — the checksum of every asset.

Each asset also has a signed build-provenance attestation. It is keyless (Sigstore), and it shows that this
repository's release workflow built the file. A checksum alone shows only that the file arrived intact. Start a
new installation from a checked download, never from a script piped into a shell:

```bash
VER=v1.0.0
curl -fsSLO https://github.com/apachler/aprscaching/releases/download/$VER/aprscaching-$VER.bundle
curl -fsSLO https://github.com/apachler/aprscaching/releases/download/$VER/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify aprscaching-$VER.bundle --repo apachler/aprscaching   # the GitHub CLI, signed in
git clone --branch $VER aprscaching-$VER.bundle aprscaching
cd aprscaching && git remote set-url origin https://github.com/apachler/aprscaching.git
deploy/aprscaching init selfhost
```

The desktop binaries and the OCI stack's zip check the same way. A release's OCI stack also names its tag's
commit, and the VM's first boot stops when the cloned tag is any other commit; it then sets up through `init
selfhost`, like any Self-host install (`deploy/oci/README-stack.md`). `init baremetal` does all of this itself for a
release tag: it downloads the bundle and `SHA256SUMS`, checks both, and clones from the bundle. It stops
when either check fails. Without the GitHub CLI it stops too, unless `--checksum-only` accepts the checksum
alone. For a branch, or a release without a bundle, it installs from git and says the checkout is
unverified.

## Next

- [Choose a shape](../choose-a-shape.md).
