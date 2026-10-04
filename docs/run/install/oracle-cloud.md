# Self-host on Oracle Cloud

This page installs the Self-host shape on Oracle Cloud with one click. It is for a sysop without a box at home;
at the end the instance answers on a free Always Free VM and you continue with [Your first hour](../first-hour.md).

The one-click stack is an Oracle Resource Manager stack. It starts the same Docker stack as
[Self-host with Docker](self-host-docker.md), the gateway, the RF ingest and Caddy, on one Always Free Ampere A1
VM, and does the setup for you. The RF ingest on the VM carries an APRS-IS feed; a radio joins through an
[ingest box](../radios/ingest-box.md) next to it or the browser.

## Before you start

- **An Oracle Cloud account.** The home region you choose at sign-up is permanent, and Always Free resources live
  there. Frankfurt (eu-frankfurt-1) usually has A1 capacity for central Europe; Zurich and Milan are alternatives.
- **A published release.** The button hands Resource Manager the `aprscaching-oci-stack.zip` attached to the
  latest release, so it works only once a release exists. Each release's zip pins its own tag: a stack created
  from `v1.2.0` deploys `v1.2.0`.
- **Your callsign**, and optionally your APRS-IS passcode. A blank passcode runs the feed receive-only until you
  set it on the VM.
- **An SSH public key** for the `ubuntu` user.
- **A DNS name** you can point at the VM, for automatic TLS. Without one the instance serves plain http on its
  address; passkeys and location need https.
- **Rights to create a dynamic group and a policy** for the nightly backups. A tenancy administrator has them.

**What it uses of the Always Free allowance.** An Always-Free-only tenancy gets 1,500 OCPU hours and 9,000 GB hours
of Ampere A1 a month: **2 OCPUs and 12 GB of memory** around the clock
([Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm), as of
1 October 2026). The stack takes exactly that, with a 50 GB boot volume of the 200 GB of block storage. It refuses
more unless you set **Allow beyond Always Free**.

## Steps

1. Open the
   [one-click stack](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip)
   and sign in to Oracle Cloud.
2. Fill in the stack's fields. It creates its own network and finds the Ubuntu image itself, so it asks for no
   OCID:

    | Field | What to enter |
    |---|---|
    | **Callsign** | Your call without an SSID. You administer the instance with it, and it logs the feed in to APRS-IS. |
    | **APRS-IS passcode** | Optional. It authenticates the feed and verifies nothing about your licence. |
    | **Feed filter** | `r/<lat>/<lon>/<km>`, local to your area. |
    | **Hostname** | The DNS name for the VM, or `:80` for plain http on its address. |
    | **SSH public key** | Your key, for logins through the Bastion. |
    | **Availability domain** | Raise it and apply again if Oracle reports it is out of host capacity. |
    | **Reserved public IP** | On: the address, and your DNS record, survive re-creating the VM. |
    | **Bastion client networks** | Who may open SSH sessions. |
    | **Nightly backups to a bucket** | On: each night's archive goes to a private bucket. |
    | **Weekly boot volume backups** | Off by default; four weekly copies of the whole disk. |

3. Select **Plan**, then **Apply**.
4. Point your DNS name at the `public_ip` output. With an existing reserved IP, run the
   `assign_reserved_ip_command` output first.
5. Wait a few minutes for the first boot. It installs Docker from Docker's signed apt repository, clones the
   release and stops when the tag points at another commit than the release names. It then runs
   `deploy/aprscaching init selfhost`, which generates the secrets on the VM, starts the stack, runs `doctor` and
   makes the first backup. The serial console (**Compute → Instances → aprscaching → Console connection**) and
   `/var/log/aprscaching-firstboot.log` show its progress.
6. For a shell on the VM, use the Bastion: port 22 is closed to the internet. From a checkout of the repository,
   with the OCI CLI set up:

    ```bash
    deploy/oci/bastion-ssh.sh --bastion-id <bastion OCID> --instance-id <instance OCID> --save   # once, from the login_command output
    deploy/oci/bastion-ssh.sh                                                                    # a shell on the VM
    ```

    The instance lives in `/opt/aprscaching`; its settings and secrets are in `/opt/aprscaching/deploy/.env`.

### Backups

With **Nightly backups to a bucket** on, the VM runs `deploy/aprscaching backup --with-media` every night between
02:30 and 03:30 UTC. The archive holds the database, the settings, the secrets and the media, and goes to the
private bucket named in the `backup_bucket` output. The bucket deletes archives after 14 days, and the VM keeps the
newest three on its own disk. `deploy/aprscaching doctor` reports the age of the newest archive.

To restore after losing the VM, select **Apply** on the stack again, wait for the first boot, then on the new VM:

```bash
cd /opt/aprscaching
sudo deploy/aprscaching restore oci://<backup_bucket>/latest
```

### Staying on the free tier

Oracle may reclaim an Always Free A1 instance whose CPU, network and memory use all stay under 20 % for seven days,
and may suspend a free account unused for 30 days ([Free Tier FAQ](https://www.oracle.com/cloud/free/faq/), as of
1 October 2026). A quiet instance can fall under that.

Upgrade the tenancy to **Pay As You Go** and set a **budget alert** (**Billing → Budgets**, for example 1 € a month
with an alert at 100 %). Always Free resources stay free on Pay As You Go, the instance is not reclaimed for being
idle, and the alert tells you the moment anything would cost money. Always Free includes 20 GB of Object Storage, so
14 nightly archives fit while each stays under about 1.4 GB.

The stack's fields, the first boot, the Bastion's IAM policies, the reserved IP and 44Net on the VM are described
in full in `deploy/oci/README-stack.md`.

## Check that it worked

- The **Open the instance** link in the stack's outputs loads the web app.
- `curl -fsS https://<your hostname>/health` answers `{"ok":true,…}`.
- On the VM, `cd /opt/aprscaching && sudo deploy/aprscaching doctor` passes, the backup check included.

## Next

- [Your first hour](../first-hour.md): sign in, confirm your call and make the instance public-ready.
- [Put Cloudflare in front](../networks/cloudflare.md): the CDN in front of the VM.
- [Updates](../day-to-day/updates.md): take a new release with `deploy/aprscaching update`.
