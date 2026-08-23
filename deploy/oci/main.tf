# SPDX-License-Identifier: AGPL-3.0-or-later
#
# OCI Resource Manager stack: one Always-Free Ampere A1 VM running the all-in-one Docker stack
# (Topology 2 — gateway + ingest + Caddy) via cloud-init. Published as a zip release artifact; the
# "Deploy to Oracle Cloud" button in README-stack.md points Resource Manager straight at it.
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
  description = "Ampere A1 cores. The Always-Free allowance is 4 in total across all instances."
  default     = 2
}
variable "memory_in_gbs" {
  type        = number
  description = "Memory. The Always-Free allowance is 24 GB in total across all instances."
  default     = 12
}
variable "boot_volume_size_in_gbs" {
  type        = number
  description = "Boot volume size. The Always-Free allowance is 200 GB in total."
  default     = 50
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

# HTTP/HTTPS for the site, SSH for the operator. Nothing else is opened: the APRS-IS feed and the
# federation pulls are outbound, so they need no ingress rule of their own.
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
    source   = "0.0.0.0/0"
    tcp_options {
      min = 22
      max = 22
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

  create_vnic_details {
    subnet_id        = oci_core_subnet.this.id
    assign_public_ip = true
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
}

output "public_ip" {
  description = "Point your DNS A record here."
  value       = oci_core_instance.this.public_ip
}

output "url" {
  description = "The instance, once cloud-init has finished (allow a few minutes for the first build)."
  value       = var.domain == ":80" ? "http://${oci_core_instance.this.public_ip}" : "https://${var.domain}"
}
