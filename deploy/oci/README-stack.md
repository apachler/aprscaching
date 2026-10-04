# OCI one-click (Resource Manager stack)

One Always-Free Ampere A1 VM running the all-in-one stack — gateway, ingest and Caddy — brought up by
cloud-init. This is the Self-host shape with the setup done for you.

**What it uses of the Always Free allowance.** Oracle's Always Free tier gives every tenancy 1,500 OCPU hours
and 9,000 GB hours of Ampere A1 a month, which for an Always-Free-only tenancy is **2 OCPUs and 12 GB of
memory** in total ([Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)).
Oracle halved it from 4 OCPUs / 24 GB around 15 June 2026; Pay As You Go tenancies reportedly still have the
larger allowance free — check *Governance → Limits, Quotas and Usage* in the console. The stack's defaults are
2 OCPUs, 12 GB and a 50 GB boot volume (of 200 GB of block storage). Asking for more fails unless you set
**Allow beyond Always Free**.

[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip)

The button hands Resource Manager the `aprscaching-oci-stack.zip` attached to the latest release, so
there is nothing to download or upload by hand. Each release's zip pins its own tag: a stack created
from `v1.2.0` deploys `v1.2.0`, not whatever `main` holds later.

## What you fill in

The stack creates its own VCN, subnet, internet gateway and security list, and resolves the Ubuntu
aarch64 image itself, so it never asks for an OCID you would have to go and find. What it does ask for:

| Field | Notes |
|-------|-------|
| Callsign | Your call without an SSID. You administer the instance with it, and it logs the instance in to APRS-IS. |
| APRS-IS passcode | Optional. Blank runs the feed receive-only until you set it on the VM (below). It authenticates the feed; it verifies nothing about your licence. |
| Feed filter | `r/<lat>/<lon>/<km>` — keep it local to your area, both for relevance and for cost. |
| Hostname | A name you point at the VM, for automatic TLS. Leave it as `:80` to serve plain HTTP over the IP address. |
| SSH public key | Login as the `ubuntu` user, through the Bastion (below). |
| Availability domain | Raise it and re-apply if OCI reports it is out of host capacity. |
| Reserved public IP | On by default; see below. |
| Bastion client networks | Who may open SSH sessions; IAM and your key authenticate each one. |
| Nightly backups to a bucket | On by default; see [Backups](#backups). Needs rights to create a dynamic group and a policy. |
| Weekly boot volume backups | Off by default; four weekly copies of the whole disk. |

Then **Plan**, then **Apply**. Point DNS at the `public_ip` output (with an existing reserved IP, run
`assign_reserved_ip_command` first); the *Open the instance* link goes straight there. The first boot builds the
images, so allow a few minutes before the site answers.

## The first boot

cloud-init runs `firstboot.sh` (in the zip) once, as root:

1. installs Docker from Docker's own apt repository, trusting its signing key only when the key's fingerprint is
   `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`;
2. clones the release. A stack from a release names its tag's commit, and the boot stops if the tag points
   anywhere else; another `repo_ref` (a branch) deploys unverified, and the log says so;
3. writes `/opt/aprscaching/deploy/.env` with `deploy/aprscaching init selfhost`, which generates
   `INGEST_SECRET` and `OPERATOR_SECRET` on the VM;
4. starts the stack, waits for the gateway, and runs `deploy/aprscaching doctor`.

Everything it prints goes to `/var/log/aprscaching-firstboot.log` and to the serial console (*Compute → Instances
→ aprscaching → Console connection*), so you can watch the boot without SSH. Running it again changes nothing that
is there: the checkout stays at its commit, `.env` keeps its values and secrets, and the data stays in its Docker
volumes. Update with `deploy/aprscaching update`.

**Without a hostname** (`:80`) the VM asks the OCI API for its public address (the guest only sees its private
one) and serves plain http there. That needs the backup bucket's policy; without it, `APP_URL` starts as the
private address: set `APP_URL=http://<public_ip>` in `/opt/aprscaching/deploy/.env`, then restart (below). A
hostname with TLS is the recommended setup: passkeys and location need https.

## Secrets and the stack's state

- **Generated on the VM, never in Terraform:** `INGEST_SECRET`, `OPERATOR_SECRET` and the federation key, in
  `/opt/aprscaching/deploy/.env` (owner-only); the session secret in the gateway's data volume. Read
  `OPERATOR_SECRET` from there over SSH (through the Bastion, below) to confirm your call with
  `tools/admin/verify-call.mjs`. Replace one with `sudo deploy/aprscaching rotate-secret <NAME>`.
- **In Resource Manager's state and the instance metadata:** what you typed into the stack — the callsign,
  the filter, the hostname and, if you gave one, the APRS-IS passcode. The passcode is marked sensitive, so
  plans and outputs hide it, but the state file holds it, and every process on the VM can read the instance
  metadata. The VM removes cloud-init's copies of it from disk after each boot. To keep the passcode out of
  OCI altogether, leave it blank and set it on the VM.

**Set or change the passcode on the VM:**

```bash
deploy/oci/bastion-ssh.sh
sudo nano /opt/aprscaching/deploy/.env           # APRSIS_PASSCODE=<your passcode>
cd /opt/aprscaching/deploy && sudo docker compose up -d
```

## Backups

With **Nightly backups to a bucket** (the default) the stack creates:

- a private Object Storage bucket, `aprscaching-backups-<suffix>` (the `backup_bucket` output), versioning off;
- a lifecycle rule that deletes archives after **14 days**;
- a dynamic group that matches this VM only, and a policy that lets it manage objects in that one bucket and
  read its own network card (for its public address). The policy also lets the Object Storage service of the
  region expire objects, which lifecycle rules need.

Every night, at a random time between 02:30 and 03:30 UTC, the `aprscaching-backup.timer` runs
`deploy/aprscaching backup --with-media`. The archive holds the database, the settings, the generated secrets
and the media. It goes to the bucket under `archives/`, signed in as the VM itself (instance principal; no
API key on the VM). The VM keeps the newest three on its own disk (`BACKUP_KEEP=3`). The first backup runs at the end of the
first boot, so a broken policy shows in the boot log at once. `deploy/aprscaching doctor` reports the age of
the newest archive in the bucket.

The archive holds the instance's secrets, so the bucket is private, and only this VM and your tenancy's
administrators can read it.

**Apply fails at the dynamic group** (`NotAuthorizedOrNotFound`, or a 404 on `oci_identity_dynamic_group`)?
Dynamic groups and policies are tenancy-level and are written in the tenancy's home region, which needs
rights to manage both — a tenancy administrator has them. Either ask an administrator to apply the stack, or
untick *Nightly backups to a bucket* and back up another way ([Backups](https://github.com/apachler/aprscaching/blob/main/docs/run/day-to-day/backups.md#what-to-back-up)).

**What it costs.** Always Free includes 20 GB of Object Storage and 50,000 API requests a month. A nightly
upload uses a handful of requests, so 14 archives fit as long as each stays under about 1.4 GB; `doctor` and
the bucket's size in the console show where you are.

**Weekly boot volume backups** (off by default) add a weekly incremental backup of the whole boot volume,
keeping four. Always Free includes five volume backups. They restore the whole VM, including Docker and the
system, from the console (*Block Storage → Boot volume backups*).

### Restore after losing the VM

1. In Resource Manager, run **Apply** on the stack again. It creates a new VM; the bucket, the reserved IP and
   the policy stay.
2. Wait for the first boot to finish (the serial console, or `/var/log/aprscaching-firstboot.log`).
3. Log in through the Bastion and restore the newest archive from the bucket:

   ```bash
   cd /opt/aprscaching
   sudo deploy/aprscaching restore oci://<backup_bucket>/latest --dry-run   # what it would restore
   sudo deploy/aprscaching restore oci://<backup_bucket>/latest
   ```

   `oci://<bucket>/archives/<name>.tar.gz` restores an older one; `oci os object list -bn <bucket> --prefix
   archives/` lists them. The restore stops the stack, puts back the database, the settings, the secrets and
   the media, starts it again and runs `doctor`.

A re-created VM is a new instance, so the dynamic group follows it once Apply updates its matching rule.

## HTTP/3

Caddy serves HTTP/3 (QUIC) on UDP port 443 beside HTTPS on TCP 443, and the security list lets UDP 443 in.
Browsers fall back to TCP when UDP is blocked on their path, so it is never required.

## The public IP

The VM gets a **reserved public IP**, so its address — and your DNS record — survives re-creating the VM.
Reserved IPs are free of charge; a free-tier tenancy reportedly has **one** (the limit is under *Governance →
Limits, Quotas and Usage → Networking → Reserved public IPs*). **Deleting the stack releases a reserved IP it
created.**

- **Already have one** (from an earlier stack, or kept on purpose)? Enter its OCID as *Existing reserved IP*.
  The stack then creates none and leaves the VM without a public address of its own; after Apply, run the
  `assign_reserved_ip_command` output once (OCI CLI, or Cloud Shell in the console). Terraform cannot take over
  an address it did not create without owning it — and then deleting the stack would release it — so this one
  step stays yours, and the IP survives the stack.
- **Apply fails at the reserved-IP limit?** Use the existing one as above, or untick *Reserved public IP* for an
  ephemeral address (which changes when the VM is re-created).
- **To keep an address across re-creating the whole stack**, reserve one yourself (*Networking → Reserved
  public IPs → Reserve*) and always pass it as *Existing reserved IP*.

## SSH: through the Bastion only

Port 22 is closed to the internet. The stack creates an **OCI Bastion** (free on every account), and SSH is open
only from the subnet its endpoint lives in. Log in from your own machine, in a checkout of this repository,
with the [OCI CLI](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm) set up (`oci setup
config`):

```bash
# the stack's login_command output, once: it remembers the bastion and the VM
deploy/oci/bastion-ssh.sh --bastion-id ocid1.bastion.oc1… --instance-id ocid1.instance.oc1… --save
deploy/oci/bastion-ssh.sh                          # a shell on the VM
deploy/oci/bastion-ssh.sh -- sudo docker ps        # one command
deploy/oci/bastion-ssh.sh --ssh-config >> ~/.ssh/config   # then: ssh / scp / rsync aprscaching-oci
```

A session takes about a minute to open and lasts up to three hours; the script reuses it until then
(`--close` ends it). The default is a **port-forwarding** session, which needs nothing on the VM; `--managed`
opens a managed SSH session through the Oracle Cloud Agent's Bastion plugin, which the stack enables. The zip
carries the script too (`bastion-ssh.sh`).

**IAM.** Your user's group needs, in the stack's compartment:

```text
allow group <your-group> to use bastion in compartment <compartment>
allow group <your-group> to manage bastion-session in compartment <compartment>
allow group <your-group> to read instances in compartment <compartment>
allow group <your-group> to read vnics in compartment <compartment>
allow group <your-group> to read vnic-attachments in compartment <compartment>
allow group <your-group> to read instance-agent-plugins in compartment <compartment>   # --managed only
```

Tenancy administrators have all of these already. Check the verbs against
[Oracle's Bastion IAM policies](https://docs.oracle.com/en-us/iaas/Content/Bastion/Reference/bastionpolicyreference.htm)
for your tenancy.

**Break-glass.** If the Bastion or the agent misbehaves, the VM's **serial console** still reaches it: *Compute →
Instances → aprscaching → Console connection → Launch Cloud Shell connection*. Cloud Shell in the console also
has the OCI CLI, and can run `bastion-ssh.sh` from a clone.

## 44Net

The VM can also carry a 44Net Connect tunnel, so the instance is reachable at a 44.x address and a
`<call>.ampr.org` name ([Run an instance on 44Net](https://github.com/apachler/aprscaching/blob/main/docs/run/networks/44net.md)).
The first boot installs `wireguard-tools` and `nftables` for it; the stack never handles the Connect configuration,
which holds the tunnel's private key. Copy it to the VM through the Bastion and let the helper bring it up:

```bash
deploy/oci/bastion-ssh.sh --ssh-config >> ~/.ssh/config     # once
scp ~/Downloads/wg44.conf aprscaching-oci:                    # the configuration Connect issued
deploy/oci/bastion-ssh.sh                                     # a shell on the VM, then:
sudo /opt/aprscaching/deploy/aprscaching net44 setup ~/wg44.conf --name aprscaching.<call>.ampr.org
rm ~/wg44.conf                                                # setup keeps its own owner-only copy
```

The helper sets the tunnel's MTU from the path to the endpoint — the VM's own MTU stays 9000, and wg-quick
would otherwise derive 8920 from it — keeps SSH on the internet link even when the configuration routes
everything through the tunnel, and lets only TCP 80/443 in on it. It starts the tunnel with a rollback scheduled: open a
**new** Bastion session while it waits, and answer `y` once that session connects. Without an answer the tunnel
goes down again after two minutes.

## ICMP and the MTU

OCI gives the VM a 9000-byte MTU, while traffic through the Internet Gateway is limited to 1500 bytes. Path MTU
Discovery needs the "fragmentation needed" message (ICMP type 3 code 4) to reach the VM, so the security list
allows it from anywhere — as OCI's default security list does — and the rest of ICMP type 3 from within the
network. Without it, large TCP replies can hang while small requests work.

To put Cloudflare's CDN in front afterwards, see `../cloudflare/`.

## Staying on the free tier

What Oracle states, as of 1 October 2026 — check the linked pages, they change:

- **The allowance.** An Always-Free-only tenancy gets 1,500 OCPU hours and 9,000 GB hours of Ampere A1 a month
  (2 OCPUs / 12 GB around the clock), 200 GB of block storage with five volume backups, 20 GB of Object Storage
  with 50,000 API requests a month, and 10 TB of outbound traffic a month
  ([Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)). Oracle halved
  the A1 allowance from 4 OCPUs / 24 GB around 15 June 2026
  ([InfoQ](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)). Pay As You Go tenancies
  reportedly keep the larger allowance free; **Unverified** — check *Governance → Limits, Quotas and Usage*. An
  instance created above the new allowance may run on but not be re-creatable.
- **Idle instances are reclaimed.** Oracle may stop an Always Free A1 instance when, over seven days, its CPU
  use (95th percentile), its network use and its memory use all stay under 20 %
  ([Free Tier FAQ](https://www.oracle.com/cloud/free/faq/)). A quiet aprscaching instance can fall under that.
  Pay As You Go tenancies are exempt.
- **Idle accounts.** A free account with no sign-in or activity for 30 days may be suspended (same FAQ).
- **The home region is permanent.** You choose it at sign-up, and Always Free resources live there.

**The recommendation:** upgrade the tenancy to **Pay As You Go** and set a **budget alert** (*Billing → Budgets*,
for example 1 € a month with an alert at 100 %). Always Free resources stay free on Pay As You Go, the instance
is not reclaimed for being idle, and the alert tells you the moment anything would cost money. The stack's
defaults stay within the allowance, and it refuses more unless you set *Allow beyond Always Free*. Do not run
tools that keep the VM busy to dodge reclamation: they burn the allowance and are against the spirit of the
offer.

**Capacity.** Always Free A1 capacity varies by region and over time. If Apply fails with "out of host capacity",
raise the availability domain and apply again, or try later. Frankfurt (eu-frankfurt-1) usually works for
central Europe; Zurich and Milan are alternatives — but only for a home region you have not chosen yet.

### Containers on OCI

The stack runs the Docker Compose stack on the A1 VM. That is the supported way, and the rest are not:

- **Container Instances** are free on A1 only for paid tenancies (sharing the A1 allowance), and their storage is
  ephemeral, so the database would need a volume they cannot keep
  ([pricing](https://www.oracle.com/cloud/cloud-native/container-instances/pricing/)).
- **Kubernetes (OKE)**: a Basic cluster's control plane is free and its workers can be A1
  ([pricing](https://www.oracle.com/cloud/cloud-native/kubernetes-engine/pricing/)), but it is far more to run
  than one instance needs, and the SQLite database has one writer anyway (see the warm-standby item in
  `TODO.md`).
- **Container Registry** is free, but images count against the 20 GB of Object Storage. The stack builds its
  images on the VM and needs none.

## Building the zip yourself

```bash
bash scripts/build-oci-stack.sh          # -> dist/oci/aprscaching-oci-stack.zip
```

Resource Manager reads `main.tf` and `schema.yaml` from the zip root, so the files are staged flat
rather than under `deploy/oci/`. `tools/checks/oci-stack.mjs` runs in CI and fails the build if the
Terraform variables, the stack UI schema, the cloud-init placeholders and the packaging script drift
apart — a mismatch there would otherwise only show up as a failed Plan in someone else's tenancy.
