# Minimal OCI stack: one Always-Free Ampere A1 VM running the all-in-one stack via cloud-init.
# Package this folder as a .zip and upload as an OCI Resource Manager stack (Deploy to Oracle Cloud).
# Fill the variables in the stack UI. This is a starting point — refine networking to taste.

terraform { required_providers { oci = { source = "oracle/oci" } } }
provider "oci" {}

variable "compartment_ocid" {}
variable "ssh_public_key"   {}
variable "availability_domain" {}        # e.g. from oci_identity_availability_domains
variable "subnet_ocid"      {}           # an existing public subnet (or add a VCN module)
variable "image_ocid"       {}           # Ubuntu 22.04 aarch64 image OCID for your region
variable "repo_url"         { default = "https://github.com/OE8APR/aprscaching" }
variable "domain"           { default = ":80" }
variable "aprsis_callsign"  {}
variable "aprsis_passcode"  {}
variable "aprsis_filter"    { default = "r/47.07/15.42/300" }
variable "ingest_secret"    {}

locals {
  cloud_init = base64encode(templatefile("${path.module}/cloud-init.yaml", {
    REPO_URL        = var.repo_url
    DOMAIN          = var.domain
    APRSIS_CALLSIGN = var.aprsis_callsign
    APRSIS_PASSCODE = var.aprsis_passcode
    APRSIS_FILTER   = var.aprsis_filter
    INGEST_SECRET   = var.ingest_secret
  }))
}

resource "oci_core_instance" "aprscaching" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  shape               = "VM.Standard.A1.Flex"
  shape_config { ocpus = 2, memory_in_gbs = 12 }   # Always-Free A1 (2/12 as of mid-2026)
  create_vnic_details { subnet_id = var.subnet_ocid, assign_public_ip = true }
  source_details { source_type = "image", source_id = var.image_ocid, boot_volume_size_in_gbs = 50 }
  metadata = { ssh_authorized_keys = var.ssh_public_key, user_data = local.cloud_init }
  display_name = "aprscaching"
}

output "public_ip" { value = oci_core_instance.aprscaching.public_ip }
