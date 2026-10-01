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
  description = "Your amateur-radio callsign, used to log in to APRS-IS."
}
variable "aprsis_passcode" {
  type        = string
  description = "Your APRS-IS passcode for that callsign."
}
variable "aprsis_filter" {
  type        = string
  description = "APRS-IS server-side filter. r/<lat>/<lon>/<km> keeps the feed local to your area."
  default     = "r/47.07/15.42/300"
}
variable "domain" {
  type        = string
  description = "Public hostname for automatic TLS. Leave as :80 to serve plain HTTP over the IP address."
  default     = ":80"
}
variable "ingest_secret" {
  type        = string
  description = "Shared secret authorising the ingest worker's writes. Use a long random string."
  sensitive   = true
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

# ---- source ----
variable "repo_url" {
  type        = string
  description = "Git repository cloned onto the host."
  default     = "https://github.com/apachler/aprscaching"
}
# scripts/build-oci-stack.sh stamps the published tag over this default when it builds the release
# zip, so a stack downloaded from a release deploys exactly that release rather than tracking main.
# Keep the line shape: the build script rewrites it and tools/checks/oci-stack.mjs asserts the match.
variable "repo_ref" {
  type        = string
  description = "Branch or tag to deploy."
  default     = "main"
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
  # sizing beyond the Always-Free allowance is an explicit opt-in
  beyond_free = var.ocpus > 2 || var.memory_in_gbs > 12
  reserve_ip  = var.use_reserved_ip && var.existing_reserved_ip_id == ""
  ad_index = min(
    max(var.availability_domain_number, 1),
    length(data.oci_identity_availability_domains.ads.availability_domains),
  ) - 1
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[local.ad_index].name
  image_id            = data.oci_core_images.ubuntu.images[0].id
  cloud_init = base64encode(templatefile("${path.module}/cloud-init.yaml", {
    REPO_URL        = var.repo_url
    REPO_REF        = var.repo_ref
    DOMAIN          = var.domain
    APRSIS_CALLSIGN = var.aprsis_callsign
    APRSIS_PASSCODE = var.aprsis_passcode
    APRSIS_FILTER   = var.aprsis_filter
    INGEST_SECRET   = var.ingest_secret
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
