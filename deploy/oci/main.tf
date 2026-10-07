# SPDX-License-Identifier: AGPL-3.0-or-later
#
# OCI Resource Manager stack: one Always-Free Ampere A1 VM running the all-in-one Docker stack
# (the self-host stack — gateway + ingest + Caddy) via cloud-init. Published as a zip release artifact; the
# "Deploy to Oracle Cloud" button in README-stack.md points Resource Manager straight at it.
#
# The defaults stay inside an Always-Free-only tenancy: 2 OCPUs and 12 GB of A1 (1,500 OCPU hours and 9,000
# GB hours a month), a 50 GB boot volume of the 200 GB, one reserved public IP. The VM takes no SSH from the
# internet: the stack creates an OCI Bastion, and port 22 is open to it alone (deploy/oci/bastion-ssh.sh logs
# in through it).
#
# Self-contained on purpose: the stack builds its own VCN/subnet/gateway and resolves the Ubuntu
# image by name, so a first-time operator is never asked for an OCID they would have to go and find.
# The three values Resource Manager injects itself (tenancy, compartment, region) are declared here
# and hidden in schema.yaml.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0.0"
    }
  }
}

provider "oci" {
  region = var.region
}

# IAM changes (the dynamic group and policy behind the backups) are made in the tenancy's home region.
provider "oci" {
  alias  = "home"
  region = local.home_region
}

# ---- injected by Resource Manager ----
variable "tenancy_ocid" {
  type        = string
  description = "Tenancy OCID (injected by Resource Manager)."
}
variable "compartment_ocid" {
  type        = string
  description = "Compartment the instance is created in (injected by Resource Manager)."
}
variable "region" {
  type        = string
  description = "Region (injected by Resource Manager)."
}

# ---- station ----
variable "aprsis_callsign" {
  type        = string
  description = "Your amateur-radio callsign, without an SSID: you administer the instance with it, and it logs in to APRS-IS."
  validation {
    condition     = can(regex("^[A-Za-z0-9]{3,7}$", var.aprsis_callsign))
    error_message = "aprsis_callsign is a callsign without an SSID, such as OE8APR."
  }
}
variable "aprsis_passcode" {
  type        = string
  description = "Your APRS-IS passcode for that callsign. Optional: blank runs receive-only until you set it on the VM."
  default     = ""
  sensitive   = true
  validation {
    condition     = can(regex("^(-1|[0-9]{1,5})?$", var.aprsis_passcode))
    error_message = "aprsis_passcode is blank, -1 or up to five digits."
  }
}
variable "aprsis_filter" {
  type        = string
  description = "APRS-IS server-side filter. r/<lat>/<lon>/<km> keeps the feed local to your area."
  default     = "r/47.07/15.42/300"
  validation {
    condition     = !can(regex("[\\r\\n]", var.aprsis_filter))
    error_message = "aprsis_filter is one line."
  }
}
variable "domain" {
  type        = string
  description = "Public hostname for automatic TLS. Leave as :80 to serve plain HTTP over the IP address."
  default     = ":80"
  validation {
    condition     = var.domain == ":80" || can(regex("^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$", var.domain))
    error_message = "domain is a hostname such as aprs.example.net, or :80."
  }
}

# ---- host ----
variable "ssh_public_key" {
  type        = string
  description = "SSH public key granting console access to the ubuntu user."
}
variable "availability_domain_number" {
  type        = number
  description = "Which availability domain to place the VM in. Bump it and re-apply if OCI reports out of host capacity."
  default     = 1
}
variable "ocpus" {
  type        = number
  description = "Ampere A1 cores. An Always-Free-only tenancy has 2 in total across all instances (1,500 OCPU hours a month); more needs allow_beyond_always_free."
  default     = 2
  validation {
    condition     = var.ocpus >= 1 && var.ocpus <= 4
    error_message = "ocpus is 1 to 4."
  }
}
variable "memory_in_gbs" {
  type        = number
  description = "Memory. An Always-Free-only tenancy has 12 GB in total across all instances (9,000 GB hours a month); more needs allow_beyond_always_free."
  default     = 12
  validation {
    condition     = var.memory_in_gbs >= 6 && var.memory_in_gbs <= 24
    error_message = "memory_in_gbs is 6 to 24."
  }
}
variable "allow_beyond_always_free" {
  type        = bool
  description = "Allow more than 2 OCPUs or 12 GB. Above that an Always-Free-only tenancy is billed; a Pay As You Go tenancy may still have a larger free A1 allowance (check Limits, Quotas and Usage in the console)."
  default     = false
}
variable "boot_volume_size_in_gbs" {
  type        = number
  description = "Boot volume size. The Always-Free allowance is 200 GB in total."
  default     = 50
}

# ---- network ----
variable "use_reserved_ip" {
  type        = bool
  description = "Give the VM a reserved public IP, so its address (and your DNS) survives re-creating it. Free of charge; free-tier tenancies reportedly have one. Deleting the stack releases a reserved IP it created."
  default     = true
}
variable "existing_reserved_ip_id" {
  type        = string
  description = "A reserved public IP you already have (its OCID): the stack creates none, gives the VM no public address of its own, and outputs the command that assigns yours to it. Deleting the stack keeps your IP."
  default     = ""
}
variable "bastion_client_cidrs" {
  type        = list(string)
  description = "Addresses allowed to open Bastion sessions. IAM and your SSH key authenticate every session; narrow this to your own network if you like."
  default     = ["0.0.0.0/0"]
}

# ---- backups ----
variable "create_backup_bucket" {
  type        = bool
  description = "Create a private Object Storage bucket the VM backs up to every night, and the dynamic group and policy that let this VM (and only it) write there. Needs rights to manage dynamic groups and policies; a tenancy administrator has them."
  default     = true
}
variable "boot_volume_backups" {
  type        = bool
  description = "Also back up the whole boot volume weekly, keeping four (Always Free includes five volume backups)."
  default     = false
}

# ---- source ----
variable "repo_url" {
  type        = string
  description = "Git repository cloned onto the host."
  default     = "https://github.com/apachler/aprscaching"
  validation {
    condition     = can(regex("^https://[^\\s]+$", var.repo_url))
    error_message = "repo_url is an https URL."
  }
}
# scripts/build-oci-stack.sh stamps the published tag over this default when it builds the release
# zip, so a stack downloaded from a release deploys exactly that release rather than tracking main.
# Keep the line shape: the build script rewrites it and tools/checks/oci-stack.mjs asserts the match.
variable "repo_ref" {
  type        = string
  description = "Branch or tag to deploy. A release stack deploys its own tag, checked against the tag's commit."
  default     = "main"
  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.repo_ref))
    error_message = "repo_ref is a branch or tag name."
  }
}

data "oci_identity_tenancy" "this" {
  tenancy_id = var.tenancy_ocid
}
data "oci_identity_regions" "all" {}
data "oci_objectstorage_namespace" "this" {
  compartment_id = var.tenancy_ocid
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Newest Canonical Ubuntu 22.04 image that boots on the A1 (aarch64) shape.
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
  state                    = "AVAILABLE"
}

locals {
  home_region = one([for r in data.oci_identity_regions.all.regions : r.name if r.key == data.oci_identity_tenancy.this.home_region_key])
  # names that are unique per tenancy (dynamic group) or namespace and region (bucket), stable for this stack
  name_suffix = substr(sha1("${var.compartment_ocid}/${var.region}"), 0, 8)
  bucket_name = "aprscaching-backups-${local.name_suffix}"
  # sizing beyond the Always-Free allowance is an explicit opt-in
  beyond_free = var.ocpus > 2 || var.memory_in_gbs > 12
  reserve_ip  = var.use_reserved_ip && var.existing_reserved_ip_id == ""
  ad_index = min(
    max(var.availability_domain_number, 1),
    length(data.oci_identity_availability_domains.ads.availability_domains),
  ) - 1
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[local.ad_index].name
  image_id            = data.oci_core_images.ubuntu.images[0].id
  # scripts/build-oci-stack.sh stamps a release's tag and its commit here. While repo_ref is that tag, the VM
  # deploys only that commit; any other ref deploys unverified. Keep the line shapes: the build script
  # rewrites them and tools/checks/oci-stack.mjs asserts the match.
  release_ref    = ""
  release_commit = ""
  pinned_commit  = var.repo_ref == local.release_ref ? local.release_commit : ""
  # firstboot.sh reads these as KEY=VALUE lines; the variable validations keep every value on one line
  firstboot_settings = join("\n", [
    "CALL=${var.aprsis_callsign}",
    "PASSCODE=${var.aprsis_passcode}",
    "FILTER=${var.aprsis_filter}",
    "DOMAIN=${var.domain}",
    "REPO_URL=${var.repo_url}",
    "REPO_REF=${var.repo_ref}",
    "PINNED_COMMIT=${local.pinned_commit}",
    "BUCKET=${var.create_backup_bucket ? local.bucket_name : ""}",
    "",
  ])
  cloud_init = base64encode(templatefile("${path.module}/cloud-init.yaml", {
    SETTINGS_B64  = base64encode(local.firstboot_settings)
    FIRSTBOOT_B64 = filebase64("${path.module}/firstboot.sh")
  }))
}

resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "aprscaching"
  dns_label      = "aprscaching"
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  enabled        = true
  display_name   = "aprscaching-igw"
}

resource "oci_core_route_table" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "aprscaching-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

# HTTP/HTTPS for the site; SSH only from the subnet, where the Bastion's endpoint lives — never from the
# internet. The APRS-IS feed and the federation pulls are outbound, so they need no ingress rule of their own.
resource "oci_core_security_list" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "aprscaching-sl"

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  ingress_security_rules {
    protocol = "6"
    source   = "10.0.1.0/24"
    tcp_options {
      min = 22
      max = 22
    }
  }

  # Path MTU Discovery: the VM's interface has a 9000-byte MTU while the Internet Gateway passes 1500, so a
  # peer's "fragmentation needed" (ICMP type 3 code 4) must reach it, or large TCP replies hang. OCI's own
  # default security list allows the same.
  ingress_security_rules {
    protocol = "1"
    source   = "0.0.0.0/0"
    icmp_options {
      type = 3
      code = 4
    }
  }
  ingress_security_rules {
    protocol = "1"
    source   = "10.0.0.0/16"
    icmp_options {
      type = 3
    }
  }

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 443
      max = 443
    }
  }

  # HTTP/3 (QUIC), which Caddy serves beside HTTPS
  ingress_security_rules {
    protocol = "17"
    source   = "0.0.0.0/0"
    udp_options {
      min = 443
      max = 443
    }
  }
}

resource "oci_core_subnet" "this" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.this.id
  cidr_block                 = "10.0.1.0/24"
  route_table_id             = oci_core_route_table.this.id
  security_list_ids          = [oci_core_security_list.this.id]
  display_name               = "aprscaching-public"
  dns_label                  = "public"
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_instance" "this" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  shape               = "VM.Standard.A1.Flex"
  display_name        = "aprscaching"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  # With a reserved IP the VNIC gets no ephemeral one: the reserved address is attached below (or, for an
  # existing one, by the command in the assign_reserved_ip_command output).
  create_vnic_details {
    subnet_id        = oci_core_subnet.this.id
    assign_public_ip = !var.use_reserved_ip
  }

  # the Bastion plugin of the Oracle Cloud Agent, for managed SSH sessions (port forwarding needs none)
  agent_config {
    plugins_config {
      name          = "Bastion"
      desired_state = "ENABLED"
    }
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_id
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = local.cloud_init
  }

  lifecycle {
    precondition {
      condition     = !local.beyond_free || var.allow_beyond_always_free
      error_message = "More than 2 OCPUs or 12 GB is beyond an Always-Free-only tenancy's A1 allowance. Set allow_beyond_always_free = true to go ahead (and check what your tenancy bills)."
    }
  }
}

# ---- backups ----
# A private bucket the VM writes its nightly archive to (deploy/aprscaching backup, under archives/). The VM's
# own identity (instance principal) may manage objects in this bucket only; it cannot delete the bucket or
# reach any other. A lifecycle rule expires archives after 14 days, so the VM never needs to delete anything.
resource "oci_objectstorage_bucket" "backups" {
  count          = var.create_backup_bucket ? 1 : 0
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.this.namespace
  name           = local.bucket_name
  access_type    = "NoPublicAccess"
  versioning     = "Disabled"
  storage_tier   = "Standard"
}

resource "oci_identity_dynamic_group" "vm" {
  count          = var.create_backup_bucket ? 1 : 0
  provider       = oci.home
  compartment_id = var.tenancy_ocid
  name           = "aprscaching-${local.name_suffix}"
  description    = "The APRScaching VM, for its backups"
  matching_rule  = "ALL {instance.id = '${oci_core_instance.this.id}'}"
}

resource "oci_identity_policy" "vm" {
  count          = var.create_backup_bucket ? 1 : 0
  provider       = oci.home
  compartment_id = var.compartment_ocid
  name           = "aprscaching-${local.name_suffix}"
  description    = "The APRScaching VM writes its backups to its own bucket; Object Storage expires them"
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.vm[0].name} to manage objects in compartment id ${var.compartment_ocid} where target.bucket.name = '${local.bucket_name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.vm[0].name} to read buckets in compartment id ${var.compartment_ocid} where target.bucket.name = '${local.bucket_name}'",
    # the VM looks up its own public address, for APP_URL when no hostname is given
    "Allow dynamic-group ${oci_identity_dynamic_group.vm[0].name} to read vnics in compartment id ${var.compartment_ocid}",
    # lifecycle rules run as the Object Storage service, which needs this to delete expired objects
    "Allow service objectstorage-${var.region} to manage object-family in compartment id ${var.compartment_ocid}",
  ]
}

resource "oci_objectstorage_object_lifecycle_policy" "backups" {
  count     = var.create_backup_bucket ? 1 : 0
  namespace = data.oci_objectstorage_namespace.this.namespace
  bucket    = oci_objectstorage_bucket.backups[0].name
  rules {
    name        = "expire-archives"
    action      = "DELETE"
    is_enabled  = true
    time_amount = 14
    time_unit   = "DAYS"
    object_name_filter {
      inclusion_prefixes = ["archives/"]
    }
  }
  depends_on = [oci_identity_policy.vm]
}

# Weekly incremental backups of the boot volume, four kept: within Always Free's five volume backups.
resource "oci_core_volume_backup_policy" "weekly" {
  count          = var.boot_volume_backups ? 1 : 0
  compartment_id = var.compartment_ocid
  display_name   = "aprscaching-weekly"
  schedules {
    backup_type       = "INCREMENTAL"
    period            = "ONE_WEEK"
    day_of_week       = "SUNDAY"
    hour_of_day       = 3
    offset_type       = "STRUCTURED"
    retention_seconds = 2419200
    time_zone         = "UTC"
  }
}

resource "oci_core_volume_backup_policy_assignment" "boot" {
  count     = var.boot_volume_backups ? 1 : 0
  asset_id  = oci_core_instance.this.boot_volume_id
  policy_id = oci_core_volume_backup_policy.weekly[0].id
}

# ---- reserved public IP ----
data "oci_core_vnic_attachments" "this" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.this.id
}
data "oci_core_private_ips" "primary" {
  vnic_id = data.oci_core_vnic_attachments.this.vnic_attachments[0].vnic_id
}
locals {
  primary_private_ip    = [for ip in data.oci_core_private_ips.primary.private_ips : ip if ip.is_primary][0]
  primary_private_ip_id = local.primary_private_ip.id
}

# A free-tier tenancy reportedly has one reserved IP: when it is in use, Apply fails here. Then pass the one
# you have as existing_reserved_ip_id, or set use_reserved_ip = false for an ephemeral address.
resource "oci_core_public_ip" "reserved" {
  count          = local.reserve_ip ? 1 : 0
  compartment_id = var.compartment_ocid
  lifetime       = "RESERVED"
  display_name   = "aprscaching"
  private_ip_id  = local.primary_private_ip_id
}

# ---- Bastion: the only way in over SSH ----
resource "oci_bastion_bastion" "this" {
  bastion_type                 = "STANDARD"
  compartment_id               = var.compartment_ocid
  target_subnet_id             = oci_core_subnet.this.id
  name                         = "aprscaching"
  client_cidr_block_allow_list = var.bastion_client_cidrs
  max_session_ttl_in_seconds   = 10800
}

locals {
  public_ip = (
    local.reserve_ip ? oci_core_public_ip.reserved[0].ip_address :
    var.use_reserved_ip ? "(assign your reserved IP: see assign_reserved_ip_command)" :
    oci_core_instance.this.public_ip
  )
}

output "public_ip" {
  description = "Point your DNS A record here."
  value       = local.public_ip
}

output "reserved_ip_id" {
  description = "The reserved public IP's OCID (the one the stack created, or the one you supplied)."
  value       = local.reserve_ip ? oci_core_public_ip.reserved[0].id : var.existing_reserved_ip_id
}

output "assign_reserved_ip_command" {
  description = "With existing_reserved_ip_id: run this once (OCI CLI, or Cloud Shell) to assign your reserved IP to the VM."
  value = (
    var.use_reserved_ip && var.existing_reserved_ip_id != "" ?
    "oci network public-ip update --public-ip-id ${var.existing_reserved_ip_id} --private-ip-id ${local.primary_private_ip_id}" :
    "(nothing to do)"
  )
}

output "backup_bucket" {
  description = "The bucket the VM backs up to (empty without create_backup_bucket)."
  value       = var.create_backup_bucket ? local.bucket_name : ""
}

output "url" {
  description = "The instance, once cloud-init has finished (allow a few minutes for the first build)."
  value       = var.domain == ":80" ? "http://${local.public_ip}" : "https://${var.domain}"
}

output "bastion_id" {
  description = "The Bastion that opens SSH sessions to the VM."
  value       = oci_bastion_bastion.this.id
}

output "instance_id" {
  description = "The VM."
  value       = oci_core_instance.this.id
}

output "private_ip" {
  description = "The VM's private address, which Bastion sessions reach."
  value       = local.primary_private_ip.ip_address
}

output "login_command" {
  description = "Log in over SSH through the Bastion (run in a checkout, with the OCI CLI set up)."
  value       = "deploy/oci/bastion-ssh.sh --bastion-id ${oci_bastion_bastion.this.id} --instance-id ${oci_core_instance.this.id} --save"
}
