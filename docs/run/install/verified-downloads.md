# Check a download

This page shows how to check a release file before you run it. It is for a sysop starting a new installation;
at the end you know the file arrived intact and was built by this repository's release workflow.

## What a release carries

Every release carries, beside the OCI stack (`aprscaching-oci-stack.zip`) and the desktop binaries:

- `aprscaching-<version>.bundle`: the release as a git bundle. Clone it, and the checkout updates like any other.
- `aprscaching-<version>-source.tar.gz`: the source.
- `pocket.sh`: the Pocket installer. It carries the release's tag and the bundle's SHA-256, so once it is
  checked, it installs only that bundle and stops when the bundle does not match.
- `aprscaching-<version>.cdx.json`: the software bill of materials (SBOM), in CycloneDX JSON. It lists the npm
  packages the app ships, each with its version, licence and package URL, for a vulnerability or licence scanner.
  The Bun runtime inside the desktop binaries is not an npm package; its licence ships as `BUN-LICENSE.txt`.
- `SHA256SUMS`: the checksum of every asset.

Each asset also has a signed build-provenance attestation. It is keyless (Sigstore), and it shows that this
repository's release workflow, `release-verify.yml`, built the file. A checksum alone shows only that the file
arrived intact. `--signer-workflow` pins the check to that workflow: without it, `gh` accepts an attestation from
any workflow of the repository, so a file attested by another workflow would pass.

## Before you start

- `sha256sum` and `curl`.
- The [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login`.

## Steps

Start a new installation from a checked download, never from a script piped into a shell. For a Self-host
installation from the release bundle:

1. Name the release and download the bundle and the checksums:

    ```bash
    VER=v1.0.0
    curl -fsSLO https://github.com/apachler/aprscaching/releases/download/$VER/aprscaching-$VER.bundle
    curl -fsSLO https://github.com/apachler/aprscaching/releases/download/$VER/SHA256SUMS
    ```

2. Check the checksum and the signature:

    ```bash
    sha256sum -c --ignore-missing SHA256SUMS
    gh attestation verify aprscaching-$VER.bundle --repo apachler/aprscaching \
      --signer-workflow apachler/aprscaching/.github/workflows/release-verify.yml
    ```

3. Clone from the bundle and point the checkout at the repository for later updates:

    ```bash
    git clone --branch $VER aprscaching-$VER.bundle aprscaching
    cd aprscaching && git remote set-url origin https://github.com/apachler/aprscaching.git
    ```

4. Continue with the install, from the root of the checkout: `deploy/aprscaching init selfhost`
   ([Self-host with Docker](self-host-docker.md)).

## Check that it worked

`sha256sum` prints `OK` for the file, and `gh attestation verify` reports a verified attestation from
`apachler/aprscaching`'s release workflow. Stop if either fails.

## Other downloads

- **Desktop binaries** and the **OCI stack's zip** check the same way: `sha256sum -c` and
  `gh attestation verify` on the file you downloaded.
- **The OCI stack** also names its tag's commit, and the VM's first boot stops when the cloned tag is any
  other commit. It then sets up through `init selfhost`, like any Self-host install
  (`deploy/oci/README-stack.md`).
- **Bare metal:** `deploy/aprscaching init baremetal` does all of this itself for a release tag. It downloads
  the bundle and `SHA256SUMS`, checks the checksum and the release workflow's attestation, and clones from the
  bundle at the commit its tag names; it stops when a check fails or cannot run. Without the GitHub CLI it stops
  too, unless `--checksum-only` accepts the checksum alone. A branch, or a release without a bundle, installs
  from git: the helper says the checkout is unverified and asks, even with `--yes`. Only `--unverified`
  installs it without asking.
- **Updates:** `deploy/aprscaching update` on Self-host, bare metal and an ingest box checks each new release
  the same way before it changes anything ([Updates](../day-to-day/updates.md#what-update-verifies)).
- **Pocket:** check `pocket.sh` the same way before you run it ([Install Pocket](pocket.md#install)).
- **The SBOM** checks the same way, then goes to the scanner of your choice:

    ```bash
    curl -fsSLO https://github.com/apachler/aprscaching/releases/download/$VER/aprscaching-$VER.cdx.json
    sha256sum -c --ignore-missing SHA256SUMS
    gh attestation verify aprscaching-$VER.cdx.json --repo apachler/aprscaching \
      --signer-workflow apachler/aprscaching/.github/workflows/release-verify.yml
    ```

## Next

- [Choose a shape](../choose-a-shape.md): pick the install page to continue with.
- [Self-host with Docker](self-host-docker.md): the recommended shape.
