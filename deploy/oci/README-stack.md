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

**Without a hostname** (`:80`) the VM cannot see its own public address, so `APP_URL` starts as its private
address. Set `APP_URL=http://<public_ip>` in `/opt/aprscaching/deploy/.env`, then restart (below). A hostname with
TLS is the recommended setup: passkeys and location need https.

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

## ICMP and the MTU

OCI gives the VM a 9000-byte MTU, while traffic through the Internet Gateway is limited to 1500 bytes. Path MTU
Discovery needs the "fragmentation needed" message (ICMP type 3 code 4) to reach the VM, so the security list
allows it from anywhere — as OCI's default security list does — and the rest of ICMP type 3 from within the
network. Without it, large TCP replies can hang while small requests work.

Capacity tip: Always-Free A1 capacity moves around. **Frankfurt (eu-frankfurt-1)** is a good bet for
central Europe; if Apply fails with "out of host capacity", raise the availability domain and retry.

To put Cloudflare's CDN in front afterwards, see `../cloudflare/`.

## Building the zip yourself

```bash
bash scripts/build-oci-stack.sh          # -> dist/oci/aprscaching-oci-stack.zip
```

Resource Manager reads `main.tf` and `schema.yaml` from the zip root, so the files are staged flat
rather than under `deploy/oci/`. `tools/checks/oci-stack.mjs` runs in CI and fails the build if the
Terraform variables, the stack UI schema, the cloud-init placeholders and the packaging script drift
apart — a mismatch there would otherwise only show up as a failed Plan in someone else's tenancy.
