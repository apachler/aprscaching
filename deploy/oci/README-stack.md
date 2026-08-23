# OCI one-click (Resource Manager stack)

One Always-Free Ampere A1 VM running the all-in-one stack — gateway, ingest and Caddy — brought up by
cloud-init. This is Topology 2 with the setup done for you.

[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip)

The button hands Resource Manager the `aprscaching-oci-stack.zip` attached to the latest release, so
there is nothing to download or upload by hand. Each release's zip pins its own tag: a stack created
from `v1.2.0` deploys `v1.2.0`, not whatever `main` holds later.

## What you fill in

The stack creates its own VCN, subnet, internet gateway and security list, and resolves the Ubuntu
aarch64 image itself, so it never asks for an OCID you would have to go and find. What it does ask for:

| Field | Notes |
|-------|-------|
| Callsign + APRS-IS passcode | Logs the instance in to APRS-IS. The passcode authenticates the feed; it verifies nothing about your licence. |
| Feed filter | `r/<lat>/<lon>/<km>` — keep it local to your area, both for relevance and for cost. |
| Hostname | A name you point at the VM, for automatic TLS. Leave it as `:80` to serve plain HTTP over the IP address. |
| Ingest secret | A long random string: `openssl rand -hex 24`. |
| SSH public key | Console access to the `ubuntu` user. |
| Availability domain | Raise it and re-apply if OCI reports it is out of host capacity. |

Then **Plan**, then **Apply**. Point DNS at the `public_ip` output; the *Open the instance* link goes
straight there. The first boot builds the images, so allow a few minutes before the site answers.

Capacity tip: Always-Free A1 capacity moves around. **Frankfurt (eu-frankfurt-1)** is a good bet for
central Europe; if Apply fails with "out of host capacity", raise the availability domain and retry.

For Topology 3, put Cloudflare in front afterwards — see `../cloudflare/`.

## Building the zip yourself

```bash
bash scripts/build-oci-stack.sh          # -> dist/oci/aprscaching-oci-stack.zip
```

Resource Manager reads `main.tf` and `schema.yaml` from the zip root, so the files are staged flat
rather than under `deploy/oci/`. `tools/checks/oci-stack.mjs` runs in CI and fails the build if the
Terraform variables, the stack UI schema, the cloud-init placeholders and the packaging script drift
apart — a mismatch there would otherwise only show up as a failed Plan in someone else's tenancy.
